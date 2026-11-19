import { useQuery } from '@tanstack/react-query';
import { NavLink, useParams, useSearchParams } from 'react-router-dom';
import type { Principal } from '../../api/types';
import { ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { useWorkspace } from '../../state/workspace';
import { returnOrderLink } from '../returns/order-entry';
import { OrderInvoiceActions } from '../invoice-documents';
import { ShippingLabelAction } from '../fulfillment/shipping-label';
import { LegacyFulfillmentPanel } from '../legacy-fulfillment';
import { DeliveryLifecyclePanel } from '../legacy-fulfillment/lifecycle';
import {
  onlineOrderDetailLink,
  parseOnlineDetailLink,
  readOnlineOrderDetail,
  type OnlineOrderDetail,
} from './online-detail-client';

const types = { N: 'Online', HL: 'Local delivery', HE: 'Express' } as const;
const money = (value: string) => `₹${value}`;
export function OnlineOrderDetailPage({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    params = useParams(),
    [query] = useSearchParams();
  const link = parseOnlineDetailLink(params.type, params.orderId, query);
  const bound = !!link && link.operatorId === user.id && link.storeId === storeId;
  const detail = useQuery({
    queryKey: [
      user.id,
      user.role,
      user.userType,
      [...user.storeIds].sort().join(','),
      'order-detail',
      storeId,
      link?.type,
      link?.orderId,
      link?.from,
      link?.to,
    ],
    enabled: bound && online,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: ({ signal }) => {
      if (!link || !bound) throw new Error('Open an order link for this workspace.');
      return readOnlineOrderDetail(
        user,
        storeId,
        link.orderId,
        { type: link.type, from: link.from, to: link.to },
        signal,
      );
    },
  });
  if (!link)
    return (
      <>
        <PageTitle title="Order details" />
        <p role="alert">This order link is invalid. Open the order from search.</p>
        <NavLink to="/orders">Open orders</NavLink>
      </>
    );
  if (!bound)
    return (
      <>
        <PageTitle title="Order details" />
        <p role="alert">
          This order link belongs to a different operator or store. Select its workspace or open the
          order from your search.
        </p>
        <NavLink to="/orders">Open orders</NavLink>
      </>
    );
  // A failed current authority read must never leave cached customer data visible.
  const value = detail.isError ? undefined : detail.data;
  return (
    <>
      <PageTitle
        title={value?.fact.reference || `Order ${link.orderId}`}
        subtitle={`${types[link.type]} order`}
      >
        <NavLink className="button secondary" to="/orders">
          Order search
        </NavLink>
        <button
          className="button secondary"
          disabled={!online || detail.isFetching}
          aria-busy={detail.isFetching}
          onClick={() => void detail.refetch()}
        >
          Refresh details
        </button>
      </PageTitle>
      {!online && (
        <p role="status">
          Offline. Loaded details are informational; reconnect to refresh or perform an action.
        </p>
      )}
      {detail.isError && (
        <ErrorState error={detail.error} retry={online ? () => void detail.refetch() : undefined} />
      )}
      {!value &&
        !detail.isError &&
        (online ? (
          <Loading label="Loading order details…" />
        ) : (
          <p role="status">Reconnect to load these order details.</p>
        ))}
      {value && <OnlineOrderDetailContent user={user} value={value} online={online} />}
    </>
  );
}
function OnlineOrderDetailContent({
  user,
  value,
  online,
}: {
  user: Principal;
  value: OnlineOrderDetail;
  online: boolean;
}) {
  const { fact, customer } = value;
  const workspace = useWorkspace();
  const counterId =
    workspace.storeId === value.storeId &&
    /^[1-9]\d{0,18}$/.test(workspace.counterId) &&
    BigInt(workspace.counterId) <= 9223372036854775807n
      ? workspace.counterId
      : undefined;
  const products = new Map(value.products.items.map((product) => [product.id, product]));
  return (
    <>
      <section className="surface" aria-label="Order overview">
        <h2>
          Order {fact.orderId} {fact.global && <span className="badge">Global order</span>}
        </h2>
        <dl className="receipt-lines">
          <div className="receipt-line">
            <dt>Amount</dt>
            <dd>{money(fact.amount)}</dd>
          </div>
          <div className="receipt-line">
            <dt>Pay amount</dt>
            <dd>{money(fact.payAmount)}</dd>
          </div>
          <div className="receipt-line">
            <dt>Payment method</dt>
            <dd>{fact.paymentMethod.label || '—'}</dd>
          </div>
          <div className="receipt-line">
            <dt>Payment status</dt>
            <dd>{fact.paymentStatus.label || '—'}</dd>
          </div>
          <div className="receipt-line">
            <dt>Order status</dt>
            <dd>{fact.status.label || '—'}</dd>
          </div>
          <div className="receipt-line">
            <dt>Placed ({fact.timeZone})</dt>
            <dd>{fact.createdAt}</dd>
          </div>
          {value.context.hyperlocalAction && (
            <div className="receipt-line">
              <dt>Local delivery action</dt>
              <dd>
                {value.context.hyperlocalAction}
                {value.context.hyperlocalPacked ? ' · Packed' : ''}
              </dd>
            </div>
          )}
          {value.context.isTransferred && (
            <div className="receipt-line">
              <dt>Transferred</dt>
              <dd>{value.context.isMoreNextIds ? 'Transferred to more stores' : 'Transferred'}</dd>
            </div>
          )}
          {value.context.eligibleStores.length > 0 && (
            <div className="receipt-line">
              <dt>Eligible stores</dt>
              <dd>
                {value.context.eligibleStores.map((store) => store.name ?? store.id).join(', ')}
              </dd>
            </div>
          )}
        </dl>
        {value.context.isTargetUser && value.context.showMarkPaymentPopUp && (
          <p role="status">This order is waiting for the store to accept it.</p>
        )}
        {value.context.hasPendingExpressItems && (
          <p role="status">Some Express items are waiting for acceptance.</p>
        )}
        {value.context.sddInvoice && (
          <p className="muted">This split order ships in more than one shipment.</p>
        )}
        {fact.delivery.parentOrderId && (
          <NavLink
            className="button secondary"
            to={onlineOrderDetailLink(user, value.storeId, fact.delivery.parentOrderId, 'HL')}
          >
            Parent local-delivery order
          </NavLink>
        )}
        {fact.delivery.childOrderId && (
          <NavLink
            className="button secondary"
            to={onlineOrderDetailLink(user, value.storeId, fact.delivery.childOrderId, 'N')}
          >
            Related online order
          </NavLink>
        )}
        {counterId &&
          (['return', 'exchange'] as const).map((kind) => (
            <NavLink
              key={kind}
              className="button secondary"
              to={returnOrderLink({
                operatorId: user.id,
                storeId: value.storeId,
                counterId,
                orderId: fact.orderId,
                kind,
              })}
            >
              {kind === 'return' ? 'Start return' : 'Start exchange'}
            </NavLink>
          ))}
        {(value.type !== 'N' || fact.paymentStatus.id === '4') && (
          <OrderInvoiceActions
            user={user}
            storeId={value.storeId}
            orderId={fact.orderId}
            online={online}
            access={value.type === 'N' ? 'global-online' : undefined}
          />
        )}
        {value.type === 'HE' && (
          <ShippingLabelAction
            user={user}
            storeId={value.storeId}
            orderId={fact.orderId}
            online={online}
          />
        )}
        {value.type === 'HL' && (
          <NavLink className="button secondary" to="/local-deliveries">
            Open local deliveries
          </NavLink>
        )}
        {value.type === 'HE' && (
          <NavLink className="button secondary" to="/fulfillment">
            Open Express fulfillment
          </NavLink>
        )}
      </section>
      <section className="surface" aria-label="Current customer profile">
        <h2>
          {customer.firstName} {customer.lastName}
        </h2>
        <p>
          Customer {customer.id} · {customer.email} · {customer.telephone}
        </p>
        <p className="muted">Current customer profile · refreshed {customer.fetchedAt}</p>
        <dl>
          <div className="receipt-line">
            <dt>TSS Money</dt>
            <dd>{money(customer.money)}</dd>
          </div>
          <div className="receipt-line">
            <dt>TSS Points</dt>
            <dd>{money(customer.points)}</dd>
          </div>
          <div className="receipt-line">
            <dt>Membership</dt>
            <dd>
              {customer.membership.active ? 'Exclusive member' : 'Non-exclusive member'}
              {customer.membership.expiry
                ? ` · until ${customer.membership.expiry.slice(0, 10)}`
                : ''}
            </dd>
          </div>
        </dl>
        {customer.membership.message && <p role="status">{customer.membership.message}</p>}
      </section>
      <section className="surface" aria-label="Order products">
        <h2>Products</h2>
        <p className="muted">Current product details · refreshed {value.products.fetchedAt}</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Line item</th>
                <th>SKU</th>
                <th>Product</th>
                <th>Platform</th>
                <th>Price</th>
                <th>Status</th>
                <th>Quantity</th>
                <th>GST (%)</th>
                <th>Return / exchange</th>
              </tr>
            </thead>
            <tbody>
              {fact.lines.map((line) => {
                const product = products.get(line.productId);
                return (
                  <tr key={line.id}>
                    <td>{line.id}</td>
                    <td>{product?.id || '—'}</td>
                    <td>
                      {line.productId !== '0' ? (
                        <NavLink
                          to={`/catalog/products/${product?.parentId && product.parentId !== '0' ? product.parentId : line.productId}`}
                        >
                          {product?.name || product?.id || 'Product unavailable'}
                        </NavLink>
                      ) : (
                        product?.name || '—'
                      )}
                    </td>
                    <td>
                      {line.platform.name ||
                        (line.platform.id === '5'
                          ? 'Express delivery'
                          : line.platform.id === '4'
                            ? 'Local delivery'
                            : line.platform.id === '3'
                              ? 'Same-day delivery'
                              : 'Standard delivery')}
                      {line.express.map((item) => (
                        <p key={item.id}>
                          Express · {item.status || '—'} · store {item.storeId || '—'}
                          {item.cancellationReason ? ` · ${item.cancellationReason}` : ''}
                        </p>
                      ))}
                    </td>
                    <td>{money(line.amount)}</td>
                    <td>{line.status}</td>
                    <td>{line.quantity}</td>
                    <td>{line.gst}</td>
                    <td>
                      {counterId
                        ? (['return', 'exchange'] as const).map((kind) => (
                            <NavLink
                              key={kind}
                              className="button secondary"
                              to={returnOrderLink({
                                operatorId: user.id,
                                storeId: value.storeId,
                                counterId,
                                orderId: fact.orderId,
                                lineId: line.id,
                                kind,
                              })}
                            >
                              {kind === 'return' ? 'Return this line' : 'Exchange this line'}
                            </NavLink>
                          ))
                        : 'Select a counter and check in to review eligibility.'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!fact.lines.length && <p>No product lines.</p>}
      </section>
      <section className="surface" aria-label="Delivery information">
        <h2>Delivery</h2>
        <dl>
          <div className="receipt-line">
            <dt>Start slot</dt>
            <dd>{fact.delivery.startSlot || '—'}</dd>
          </div>
          <div className="receipt-line">
            <dt>End slot</dt>
            <dd>{fact.delivery.endSlot || '—'}</dd>
          </div>
          <div className="receipt-line">
            <dt>Courier order</dt>
            <dd>{fact.delivery.courier.id || '—'}</dd>
          </div>
          <div className="receipt-line">
            <dt>Support ticket</dt>
            <dd>
              {fact.delivery.ticket.id || '—'}
              {fact.delivery.ticket.status ? ` · ${fact.delivery.ticket.status}` : ''}
            </dd>
          </div>
        </dl>
        {fact.delivery.ticket.message && <p>{fact.delivery.ticket.message}</p>}
        {fact.delivery.courier.sourceTracking && (
          <a
            className="button secondary"
            href={fact.delivery.courier.sourceTracking}
            target="_blank"
            rel="noopener noreferrer"
          >
            Track pickup
          </a>
        )}
        {fact.delivery.courier.destinationTracking && (
          <a
            className="button secondary"
            href={fact.delivery.courier.destinationTracking}
            target="_blank"
            rel="noopener noreferrer"
          >
            Track delivery
          </a>
        )}
      </section>
      {value.type === 'HL' && (
        <section aria-label="Local delivery actions">
          <LegacyFulfillmentPanel user={user} storeId={value.storeId} orderId={fact.orderId} />
          <DeliveryLifecyclePanel user={user} storeId={value.storeId} orderId={fact.orderId} />
        </section>
      )}
      <section className="surface" aria-label="Order transaction timeline">
        <h2>Transaction logs</h2>
        {fact.timeline.map((event) => (
          <article key={event.id}>
            <h3>{event.comment || 'Order update'}</h3>
            <p>{event.createdAt}</p>
            <dl>
              {event.payments.map((payment) => (
                <div className="receipt-line" key={payment.method}>
                  <dt>
                    {payment.method.toUpperCase()}
                    {payment.method.toUpperCase() === 'POC PAY AMT' ? ' (Not paid)' : ''}
                  </dt>
                  <dd>{payment.value ?? '—'}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
      </section>
    </>
  );
}
