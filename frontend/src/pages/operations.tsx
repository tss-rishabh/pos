import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Building2, CheckCircle2, Search, X } from 'lucide-react';
import type { Principal, Store } from '../api/types';
import { useOnline, useProducts } from '../hooks/use-pos';
import { useWorkspace } from '../state/workspace';
import { currency } from '../lib/format';
import { Empty, ErrorState, Loading, Metric, PageTitle } from '../components/common';
import { request } from '../api/client';
import {
  orderBrowseDetail,
  orderBrowserDates,
  type StoreOrderLegacy,
} from './order-history/client';
import {
  AutomaticInvoicePreview,
  createAutomaticInvoiceRequest,
  OrderInvoiceActions,
  type AutomaticInvoiceRequest,
} from './invoice-documents';
import { InvoiceActions } from './checkout';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { orderLink, orderLinkState } from './checkout/order-link';
import { OrderPaymentActions } from './checkout/OrderPaymentActions';
import { OrderCancellationActions } from './checkout/cancellations/OrderCancellationActions';
import { SourceOrderList } from './order-history/SourceOrderList';
import {
  orderSearchScope,
  useOrderSearchOptions,
  type OrderDefaultRanges,
} from './order-history/search-client';
import { PaymentReversalPanel } from './payment-reversals';
import type { CorrectionReceipt } from './payment-reversals/client';
import { WholeOrderStatusActions } from './order-status';

export function InventoryPage({ user, storeId }: { user: Principal; storeId: string }) {
  const [search, setSearch] = useState('');
  const products = useProducts(user.id, storeId, search, true);
  const rows = products.data?.pages.flatMap((p) => p.data) || [];
  return (
    <>
      <PageTitle eyebrow="EVERY ITEM, ACCOUNTED FOR" title="Store inventory">
        <NavLink className="button secondary" to="/catalog/inventory">
          Stock across stores
        </NavLink>
        <NavLink className="button secondary" to="/catalog">
          Product catalog
        </NavLink>
        {user.role !== 5 && (
          <NavLink className="button secondary" to="/inventory/associations">
            Inventory associations
          </NavLink>
        )}
      </PageTitle>
      <div className="metrics">
        <Metric label="Products loaded" value={String(rows.length)} note="Current selection" />
        <Metric
          label="Available units"
          value={String(rows.reduce((n, p) => n + p.stock, 0))}
          note="Across loaded products"
        />
        <Metric
          label="Low stock"
          value={String(rows.filter((p) => p.stock > 0 && p.stock < 5).length)}
          note="Fewer than 5 units"
        />
        <Metric
          label="Out of stock"
          value={String(rows.filter((p) => p.stock === 0).length)}
          note="Across loaded products"
        />
      </div>
      <section className="surface">
        <div className="surface-title">
          <h2>Inventory overview</h2>
          <div className="search compact">
            <Search size={17} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a product"
              aria-label="Find inventory product"
            />
          </div>
        </div>
        {products.isPending ? (
          <Loading />
        ) : products.isError ? (
          <ErrorState error={products.error} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU / Barcode</th>
                  <th>Price</th>
                  <th>Units</th>
                  <th>Availability</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <small>{p.erpName}</small>
                    </td>
                    <td className="mono">{p.barcode || p.id}</td>
                    <td>{currency(p.price)}</td>
                    <td>{p.stock}</td>
                    <td>
                      <span
                        className={`badge ${p.stock === 0 ? 'red' : p.stock < 5 ? 'amber' : 'green'}`}
                      >
                        {p.stock === 0 ? 'Out of stock' : p.stock < 5 ? 'Low stock' : 'In stock'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <Empty title="No matching products" />}
          </div>
        )}
        {products.hasNextPage && (
          <button
            className="button secondary load-more"
            onClick={() => void products.fetchNextPage()}
          >
            Load more
          </button>
        )}
      </section>
    </>
  );
}
export function OrdersPage({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    counterId = useWorkspace((state) => state.counterId),
    [automaticInvoice, setAutomaticInvoice] = useState<AutomaticInvoiceRequest | null>(null);
  const [confirmedCorrection, setConfirmedCorrection] = useState<{
    scopeKey: string;
    orderId: string;
    receipt: CorrectionReceipt;
  } | null>(null);
  const orderMetadata = useOrderSearchOptions(user, storeId, online);
  const authorityScope = orderSearchScope(user, storeId);
  const [defaultAnchor, setDefaultAnchor] = useState<{
    scope: string;
    value: OrderDefaultRanges;
  } | null>(null);
  const [initialClock] = useState(() => Date.now());
  const defaults = defaultAnchor?.scope === authorityScope ? defaultAnchor.value : undefined;
  useEffect(() => {
    if (!orderMetadata.isFetchedAfterMount || !orderMetadata.data?.defaults) return;
    const value = orderMetadata.data.defaults;
    setDefaultAnchor((old) =>
      old?.scope === authorityScope ? old : { scope: authorityScope, value },
    );
  }, [authorityScope, orderMetadata.data, orderMetadata.isFetchedAfterMount]);
  const [searchParams, setSearchParams] = useSearchParams(),
    location = useLocation(),
    dates = orderBrowserDates(searchParams, initialClock, defaults),
    scope = { operatorId: user.id, storeId },
    link = orderLink(searchParams, location.state as unknown, scope),
    selected = link.needsBinding ? '' : link.id;
  const [refreshToken, setRefreshToken] = useState(0),
    [paymentRevision, setPaymentRevision] = useState(0),
    [dateDraft, setDateDraft] = useState({ from: dates.from, to: dates.to });
  const orders = { refetch: () => setRefreshToken((value) => value + 1) };
  const cashScopeKey = JSON.stringify([
    user.id,
    user.role,
    user.userType,
    [...user.storeIds].sort(),
    storeId,
    counterId,
  ]);
  useEffect(() => setConfirmedCorrection(null), [cashScopeKey, selected]);
  useEffect(
    () => setDateDraft({ from: dates.from, to: dates.to }),
    [dates.from, dates.to, user.id, storeId],
  );
  useEffect(() => setAutomaticInvoice(null), [user.id, storeId, selected]);
  // Legacy `?cr=1`: an order opened from an order-ID search may belong to another store.
  const [crossAccess, setCrossAccess] = useState<{ scope: string; orderId: string } | null>(null);
  const crossAccessOpen = crossAccess?.scope === authorityScope && crossAccess.orderId === selected;
  const view = searchParams.get('view') === 'online' ? 'online' : 'store';
  const setSelected = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('orderId', id);
    else {
      next.delete('orderId');
      setCrossAccess(null);
    }
    setSearchParams(next, {
      replace: true,
      state: orderLinkState(location.state as unknown, id ? scope : null),
    });
  };
  useEffect(() => {
    if (link.mismatch) {
      const next = new URLSearchParams(searchParams);
      next.delete('orderId');
      setSearchParams(next, {
        replace: true,
        state: orderLinkState(location.state as unknown, null),
      });
    } else if (link.needsBinding) {
      setSearchParams(searchParams, {
        replace: true,
        state: orderLinkState(location.state as unknown, scope),
      });
    }
  }, [link.mismatch, link.needsBinding, location.key, user.id, storeId]);
  const detail = useQuery({
    queryKey: [user.id, 'order', storeId, selected, crossAccessOpen],
    enabled: !!selected && online,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/stores/${storeId}/orders/${selected}` + (crossAccessOpen ? '?cr=1' : ''),
        { operatorId: user.id, signal },
        orderBrowseDetail,
      ),
    retry: false,
  });
  return (
    <>
      <PageTitle
        eyebrow="FROM FIRST SCAN TO FINAL RECEIPT"
        title={view === 'online' ? 'Online orders' : 'Orders'}
      >
        <button
          className="button secondary"
          onClick={() => {
            const next = new URLSearchParams(searchParams);
            if (view === 'online') next.delete('view');
            else next.set('view', 'online');
            next.delete('orderId');
            setSearchParams(next, { replace: true });
          }}
        >
          {view === 'online' ? 'Store orders' : 'Online orders'}
        </button>
        <button className="button secondary" onClick={() => void orders.refetch()}>
          Refresh orders
          <ArrowUpRight size={16} />
        </button>
      </PageTitle>
      {link.invalid && (
        <p className="inline-error" role="alert">
          The order link contains an invalid reference.
        </p>
      )}
      <form
        className="surface"
        aria-label="Order dates"
        onSubmit={(event) => {
          event.preventDefault();
          if (!dates.explicit && dateDraft.from === dates.from && dateDraft.to === dates.to) {
            setRefreshToken((value) => value + 1);
            return;
          }
          const next = new URLSearchParams(searchParams);
          next.set('from', dateDraft.from);
          next.set('to', dateDraft.to);
          next.delete('orderId');
          setSearchParams(next, {
            replace: true,
            state: orderLinkState(location.state as unknown, null),
          });
        }}
      >
        <label>
          From{' '}
          <input
            aria-label="Orders from"
            type="date"
            required
            value={dates.explicit || defaults ? dateDraft.from : ''}
            disabled={!dates.explicit && !defaults}
            onChange={(event) => setDateDraft({ ...dateDraft, from: event.currentTarget.value })}
          />
        </label>
        <label>
          To{' '}
          <input
            aria-label="Orders to"
            type="date"
            required
            value={dates.explicit || defaults ? dateDraft.to : ''}
            disabled={!dates.explicit && !defaults}
            onChange={(event) => setDateDraft({ ...dateDraft, to: event.currentTarget.value })}
          />
        </label>
        <button className="button secondary" type="submit" disabled={!online}>
          Apply dates
        </button>
        <p className="muted">
          Store orders open the last five days by default. The Online view has no default date
          range.
        </p>
      </form>
      {!dates.valid && (
        <p className="inline-error" role="alert">
          Use valid start and end dates.
        </p>
      )}
      {!online && (
        <p role="status">
          Offline. Loaded order details are informational; reconnect to refresh or perform an
          action.
        </p>
      )}
      {dates.valid &&
        !dates.explicit &&
        !defaults &&
        (orderMetadata.isError ? (
          <ErrorState error={orderMetadata.error} />
        ) : !online ? (
          <p role="status">Reconnect to load the original order date window.</p>
        ) : orderMetadata.data ? (
          <p role="alert">The server did not provide the original order date window.</p>
        ) : (
          <Loading />
        ))}
      {dates.valid && (dates.explicit || defaults) && (
        <SourceOrderList
          key={`${user.id}:${user.role}:${user.userType}:${user.storeIds.join(',')}:${storeId}:${view}`}
          view={view}
          user={user}
          storeId={storeId}
          dates={{ from: dates.from, to: dates.to, explicit: dates.explicit }}
          defaults={defaults}
          options={orderMetadata.data}
          online={online}
          refreshToken={refreshToken}
          onOpen={(row, options) => {
            setCrossAccess(options.crossAccess ? { scope: authorityScope, orderId: row.id } : null);
            setSelected(row.id);
          }}
        />
      )}
      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected('')}>
          <section
            className="modal wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="order-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              aria-label="Close order"
              onClick={() => setSelected('')}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">ORDER DETAILS</div>
            <h2 id="order-title">{detail.data?.reference || selected}</h2>
            {confirmedCorrection?.scopeKey === cashScopeKey &&
              confirmedCorrection.orderId === selected &&
              (detail.isPending || detail.isError || !detail.data) && (
                <p role="status" aria-label="Confirmed cash correction">
                  Returned cash is recorded. Financial reference{' '}
                  <code>{confirmedCorrection.receipt.id}</code>. Do not return cash again.
                </p>
              )}
            {!online && !detail.data ? (
              <Empty title="Connect to load order details" />
            ) : detail.isPending ? (
              <Loading />
            ) : detail.isError ? (
              <ErrorState error={detail.error} />
            ) : (
              <>
                <p>
                  {detail.data?.status} · {currency(detail.data?.amount || 0)}
                </p>
                <p className="muted">Placed {detail.data?.createdAt}</p>
                {detail.data?.legacy && <StoreOrderContext legacy={detail.data.legacy} />}
                {detail.data?.isPaid && (
                  <InvoiceActions storeId={storeId} orderId={selected} ownerId={user.id} />
                )}
                <OrderInvoiceActions
                  key={`invoices:${user.id}:${storeId}:${selected}`}
                  user={user}
                  storeId={storeId}
                  orderId={selected}
                  online={online}
                />
                <OrderPaymentActions
                  key={`${user.id}:${storeId}:${selected}:${paymentRevision}`}
                  ownerId={user.id}
                  storeId={storeId}
                  orderId={selected}
                  onPaid={(receipt, origin) => {
                    if (origin === 'action' && receipt.orderId === selected) {
                      // Optional invoice publication cannot change a confirmed payment.
                      try {
                        setAutomaticInvoice(createAutomaticInvoiceRequest(user, storeId, receipt));
                      } catch {
                        /* The manual invoice action remains available. */
                      }
                    }
                    void detail.refetch();
                    void orders.refetch();
                  }}
                />
                <WholeOrderStatusActions
                  user={user}
                  storeId={storeId}
                  orderId={selected}
                  online={online}
                />
                {[1, 2, 3].includes(user.role) && (
                  <PaymentReversalPanel
                    key={`cash-correction:${cashScopeKey}:${selected}`}
                    deferUntilOpened
                    user={user}
                    storeId={storeId}
                    orderId={selected}
                    online={online}
                    onCorrected={async (receipt) => {
                      if (receipt.storeId !== storeId || receipt.orderId !== selected)
                        throw new Error('The financial receipt belongs to a different order.');
                      setConfirmedCorrection({
                        scopeKey: cashScopeKey,
                        orderId: selected,
                        receipt,
                      });
                      setAutomaticInvoice(null);
                      setPaymentRevision((value) => value + 1);
                      await detail.refetch();
                      orders.refetch();
                    }}
                  />
                )}
                <OrderCancellationActions
                  key={`cancel:${user.id}:${storeId}:${selected}`}
                  ownerId={user.id}
                  storeId={storeId}
                  orderId={selected}
                  onCancelled={() => {
                    void detail.refetch();
                    void orders.refetch();
                  }}
                />
                {detail.data?.legacy && <h3>Products (Items : {detail.data.legacy.totalItems})</h3>}
                {detail.data?.lines.map((l) => (
                  <div className="receipt-line" key={l.id}>
                    <div>
                      <strong>{l.name}</strong>
                      <small>
                        Line {l.id} · SKU {l.productId} · ERP {l.erpProduct ?? '-'} · {l.quantity}{' '}
                        item(s) · {l.status} · GST {l.gst}%
                      </small>
                      {detail.data?.legacy?.giftVouchers
                        .filter((voucher) => voucher.id === l.giftVoucherId)
                        .map((voucher) => (
                          <small key={voucher.id}>SR. NO {voucher.giftCardSrno}</small>
                        ))}
                      {detail.data?.legacy?.isShopifyOrder ? (
                        <small>Shopify Order not eligible for return</small>
                      ) : l.productType === '8' ? (
                        <small>Not Applicable For Return / Exchange</small>
                      ) : !detail.data?.legacy?.isAtStore ? (
                        <small>Check-in first to check return/exchange status</small>
                      ) : (
                        <NavLink to={`/returns?orderId=${selected}`}>Return / exchange</NavLink>
                      )}
                    </div>
                    <strong>{currency(l.amount)}</strong>
                  </div>
                ))}
              </>
            )}
          </section>
        </div>
      )}
      {automaticInvoice &&
        automaticInvoice.ownerId === user.id &&
        automaticInvoice.storeId === storeId &&
        automaticInvoice.receipt.orderId === selected && (
          <AutomaticInvoicePreview
            key={automaticInvoice.id}
            user={user}
            request={automaticInvoice}
            online={online}
            onClose={() => setAutomaticInvoice(null)}
          />
        )}
    </>
  );
}
export function StoresPage({
  stores,
  onSelect,
}: {
  stores: Store[];
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <PageTitle eyebrow="CONNECTED BY THE COUNTER" title="Your stores" />
      <div className="store-grid">
        {stores.map((store) => (
          <article key={store.id} className="store-card">
            <div className="store-icon">
              <Building2 size={26} />
            </div>
            <span className="badge green">
              <CheckCircle2 size={12} />
              Active
            </span>
            <h2>{store.name}</h2>
            <p>{store.city}</p>
            <div className="store-code">{store.locationCode}</div>
            <button className="button secondary full" onClick={() => onSelect(store.id)}>
              Open store
              <ArrowUpRight size={17} />
            </button>
          </article>
        ))}
      </div>
      {!stores.length && (
        <Empty title="No stores assigned">Your administrator can assign your store access.</Empty>
      )}
    </>
  );
}

function StoreOrderContext({ legacy }: { legacy: StoreOrderLegacy }) {
  const customer = legacy.customer;
  return (
    <section aria-label="Order context">
      {customer && (
        <>
          <h3>
            {customer.firstName} {customer.lastName}
          </h3>
          <p className="muted">
            {customer.email} ({customer.id}) · {customer.telephone}
          </p>
          {legacy.exclusive.member && (
            <p>
              Exclusive member
              {legacy.exclusive.expiry ? ` · Exclusive Expiry ${legacy.exclusive.expiry}` : ''}
            </p>
          )}
          {legacy.exclusive.message && <p role="status">{legacy.exclusive.message}</p>}
          <p>
            TSS Money {customer.tssMoney} · TSS Points {customer.tssPoints}
          </p>
        </>
      )}
      <dl>
        <div className="receipt-line">
          <dt>Payment status</dt>
          <dd>{legacy.paymentStatus?.label ?? ''}</dd>
        </div>
        <div className="receipt-line">
          <dt>Payment method</dt>
          <dd>{(legacy.paymentMethod?.name ?? '').toUpperCase()}</dd>
        </div>
        <div className="receipt-line">
          <dt>Order status</dt>
          <dd>{(legacy.orderStatus?.label ?? '').toUpperCase()}</dd>
        </div>
        <div className="receipt-line">
          <dt>Store</dt>
          <dd>{legacy.storeName}</dd>
        </div>
        <div className="receipt-line">
          <dt>Transaction ID</dt>
          <dd>{legacy.transactionId}</dd>
        </div>
      </dl>
      {legacy.orderMessage && <p>Message : {legacy.orderMessage}</p>}
      {legacy.isOfflineOrder && <p>Order Mode : Punched Offline Order</p>}
      {legacy.isShopifyOrder && <p>Order Mode : Punched Shopify Order</p>}
      {legacy.crossAccess && <p className="muted">Opened from an order-ID search (other store).</p>}
      <h3>Vinculum Status</h3>
      <dl>
        {(['CREATE', 'PACK', 'SHIP', 'DELIVER'] as const).map((platform) => (
          <div className="receipt-line" key={platform}>
            <dt>{platform}</dt>
            <dd>
              {legacy.vincStatus[platform]?.status ?? '-'} {legacy.vincStatus[platform]?.date ?? ''}
            </dd>
          </div>
        ))}
      </dl>
      <h3>Transaction logs</h3>
      {legacy.transactionLog.map((entry, index) => (
        <article key={index}>
          <p>
            <strong>{entry.comment}</strong> · {entry.createdAt}
          </p>
          <p className="muted">
            {entry.orderStatus} · {entry.paymentStatus}
          </p>
          <dl>
            {entry.payments.map((payment) => (
              <div className="receipt-line" key={payment.method}>
                <dt>{payment.method.toUpperCase()}</dt>
                <dd>{payment.value ?? '—'}</dd>
              </div>
            ))}
          </dl>
        </article>
      ))}
    </section>
  );
}
