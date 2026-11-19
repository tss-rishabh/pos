import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lightbulb } from 'lucide-react';
import { captureOperatorScope } from '../../api/client';
import { ErrorState, Loading, RequestReference, useProblem } from '../../components/common';
import { requireCachedOperatorSession } from '../../offline/operator-session';
import {
  readCustomerBriefing,
  type BriefingProduct,
  type CustomerBriefing,
} from './briefing-client';
import type { ProfileScope } from './client';
import './style.css';

const rupees = (amount: number | null) =>
  amount === null ? '—' : '₹' + Math.round(amount).toLocaleString('en-IN');
const quantity = (count: number | null) => (count === null ? '—' : count.toLocaleString('en-IN'));

function ProductStock({ product }: { product: BriefingProduct }) {
  const [brokenImage, setBrokenImage] = useState(false);
  let image: string | null = null;
  try {
    if (product.image_url) {
      const url = new URL(product.image_url);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.hash)
        image = url.href;
    }
  } catch {
    /* Invalid images render the accessible fallback. */
  }
  return (
    <div className="customer-insight-product">
      {image && !brokenImage ? (
        <img
          src={image}
          alt={product.name || 'Recommended product'}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBrokenImage(true)}
        />
      ) : (
        <span className="customer-insight-no-image">No image</span>
      )}
      <div>
        <strong>{product.name || 'Recommended product'}</strong>
        {product.sizes.length ? (
          <div className="customer-insight-stock">
            <table aria-label={`Stock by size for ${product.name || 'recommended product'}`}>
              <thead>
                <tr>
                  <th scope="col">Size</th>
                  {product.sizes.map((size, index) => (
                    <th scope="col" key={index}>
                      {size.size}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Available in-store</th>
                  {product.sizes.map((size, index) => (
                    <td key={index}>{quantity(size.store ?? 0)}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">Online</th>
                  {product.sizes.map((size, index) => (
                    <td key={index}>{quantity(size.online ?? 0)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="caption">
            Available in-store: {quantity(product.store ?? 0)} · Online: {quantity(product.online)}
          </p>
        )}
      </div>
    </div>
  );
}
export function CustomerBriefingCard({
  briefing,
  customerId,
}: {
  briefing: CustomerBriefing;
  customerId: string;
}) {
  return (
    <article className="customer-insight-card" aria-label="Customer briefing">
      <h3>{briefing.customer?.name || `Customer ${briefing.user_id || customerId}`}</h3>
      <div className="customer-insight-pills">
        {briefing.occasion && (
          <span>
            {briefing.occasion.emoji} {briefing.occasion.text}
          </span>
        )}
        {briefing.segment && <span>{briefing.segment}</span>}
        {briefing.customer?.is_exclusive && <span>★ Exclusive</span>}
      </div>
      <dl className="customer-insight-meta">
        {briefing.last_visit && (
          <>
            <dt>Last visit</dt>
            <dd>
              {briefing.last_visit}
              {briefing.home_store ? ` @ ${briefing.home_store}` : ''}
            </dd>
          </>
        )}
        {briefing.avg_order_value !== null && (
          <>
            <dt>Average in-store</dt>
            <dd>{rupees(briefing.avg_order_value)}</dd>
          </>
        )}
        {briefing.total_spend !== null && briefing.total_spend > 0 && (
          <>
            <dt>Spent (2 years)</dt>
            <dd>{rupees(briefing.total_spend)}</dd>
          </>
        )}
        {briefing.customer_since && (
          <>
            <dt>Customer since</dt>
            <dd>
              {briefing.customer_since.date}
              {briefing.customer_since.tenure ? ` · ${briefing.customer_since.tenure}` : ''}
            </dd>
          </>
        )}
      </dl>
      {briefing.sizes.length > 0 && (
        <div className="customer-insight-sizes">
          <strong>Sizes</strong>
          {briefing.sizes.map((size, index) => (
            <span key={index}>
              {size.usual_size}
              {size.size_drifted && size.recent_size ? ` → ${size.recent_size}` : ''} {size.label}
            </span>
          ))}
        </div>
      )}
      <ul className="customer-insight-actions">
        {briefing.action_points.length === 0 && <li>No actions for this customer.</li>}
        {briefing.action_points.map((point, index) =>
          point.kind === 'rec' ? (
            <li key={index}>
              <details>
                <summary>
                  <span className="customer-insight-category">
                    {point.category === 'cart'
                      ? 'Cart'
                      : point.category === 'wishlist'
                        ? 'Wishlist'
                        : 'Cross-sell'}
                  </span>
                  {point.prompt || point.text}
                  {point.count > 1 ? ` · +${point.count - 1} more` : ''}
                </summary>
                <div>
                  {point.items.length ? (
                    point.items.map((product, itemIndex) => (
                      <ProductStock key={itemIndex} product={product} />
                    ))
                  ) : (
                    <p className="caption">No stock detail available.</p>
                  )}
                </div>
              </details>
            </li>
          ) : (
            <li key={index}>
              <strong>{point.text}</strong>
              {point.note && <p className="customer-insight-note">⚠ {point.note}</p>}
            </li>
          ),
        )}
      </ul>
    </article>
  );
}

export function CustomerInsights({
  scope,
  checkoutVersion,
  online,
  disabled,
  initiallyOpen = false,
}: {
  scope: ProfileScope;
  checkoutVersion: number;
  online: boolean;
  disabled: boolean;
  /** Legacy opens insights right after a customer is connected (create_order.html:3021). */
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [problem, setProblem, problemCause, reportProblem] = useProblem();
  const briefing = useQuery({
    queryKey: [
      scope.operatorId,
      'customer-insights',
      scope.storeId,
      scope.checkoutId,
      scope.customerId,
      checkoutVersion,
    ],
    queryFn: ({ signal }) => readCustomerBriefing(scope, checkoutVersion, signal),
    enabled: open && online && !disabled,
    staleTime: 180000,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  async function authorizeOpen() {
    try {
      const owner = captureOperatorScope(scope.operatorId);
      await requireCachedOperatorSession(scope.operatorId, scope.storeId, owner);
      owner.throwIfAborted();
      setProblem('');
      setOpen(true);
    } catch (error) {
      setOpen(false);
      reportProblem(error, 'Sign in to view customer insights.');
    }
  }
  function prefetch() {
    if (
      online &&
      !disabled &&
      !briefing.isFetching &&
      (!briefing.data || Date.now() - briefing.dataUpdatedAt >= 180000)
    )
      void briefing.refetch();
  }
  return (
    <section className="customer-insights" aria-label="Customer insights">
      <button
        type="button"
        className="button secondary"
        disabled={!online || disabled}
        aria-expanded={open && online && !disabled}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        onClick={() => (open ? setOpen(false) : void authorizeOpen())}
      >
        <Lightbulb size={15} /> {open && online ? 'Hide customer insights' : 'Customer insights'}
      </button>
      {problem && online && (
        <p role="alert" className="inline-error">
          {problem}
        </p>
      )}
      {problem && online && <RequestReference error={problemCause} />}
      {open && online && !disabled && (
        <div className="customer-profile-panel">
          {briefing.isPending || briefing.isFetching ? (
            <Loading />
          ) : briefing.isError ? (
            <ErrorState error={briefing.error} retry={() => void briefing.refetch()} />
          ) : (
            briefing.data && (
              <CustomerBriefingCard
                briefing={briefing.data.briefing}
                customerId={scope.customerId}
              />
            )
          )}
        </div>
      )}
    </section>
  );
}
