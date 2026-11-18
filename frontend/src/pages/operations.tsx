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
  orderDateQuery,
  currentOrderDay,
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
import { CashReturnPendingQueue, PaymentReversalPanel } from './payment-reversals';
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
  const [rowDetail, setRowDetail] = useState<{
    scope: string;
    orderId: string;
    from: string;
    to: string;
  } | null>(null);
  const detailDates =
    rowDetail?.scope === authorityScope && rowDetail.orderId === selected
      ? { from: rowDetail.from, to: rowDetail.to }
      : dates.explicit
        ? { from: dates.from, to: dates.to }
        : undefined;
  const setSelected = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('orderId', id);
    else {
      next.delete('orderId');
      setRowDetail(null);
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
    queryKey: [
      user.id,
      'order',
      storeId,
      selected,
      detailDates?.from ?? null,
      detailDates?.to ?? null,
    ],
    enabled: !!selected && online && dates.valid,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/stores/${storeId}/orders/${selected}` +
          (detailDates ? '?' + orderDateQuery(detailDates) : ''),
        { operatorId: user.id, signal },
        orderBrowseDetail,
      ),
    retry: false,
  });
  return (
    <>
      <PageTitle eyebrow="FROM FIRST SCAN TO FINAL RECEIPT" title="Orders">
        <button className="button secondary" onClick={() => void orders.refetch()}>
          Refresh orders
          <ArrowUpRight size={16} />
        </button>
      </PageTitle>
      {[1, 2, 3].includes(user.role) && storeId && (
        <CashReturnPendingQueue key={cashScopeKey} user={user} storeId={storeId} online={online} />
      )}
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
          Today opens live store orders. Earlier or mixed dates open a verified historical snapshot.
          Select up to 62 calendar days.
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
          key={`${user.id}:${user.role}:${user.userType}:${user.storeIds.join(',')}:${storeId}`}
          user={user}
          storeId={storeId}
          dates={{ from: dates.from, to: dates.to, explicit: dates.explicit }}
          defaults={defaults}
          options={orderMetadata.data}
          online={online}
          refreshToken={refreshToken}
          onOpen={(row) => {
            const day = row.created_at.slice(0, 10);
            setRowDetail(
              !dates.explicit &&
                day <
                  (defaults
                    ? currentOrderDay(Date.parse(defaults.generatedAt), defaults.timeZone)
                    : dates.to)
                ? { scope: authorityScope, orderId: row.id, from: day, to: day }
                : null,
            );
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
                {detail.data?.reader === 'bigquery' && (
                  <p role="status">
                    Historical snapshot. Payment, cancellation and invoice actions independently
                    verify current records.
                  </p>
                )}
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
                    showPendingQueue={false}
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
                {detail.data?.lines.map((l) => (
                  <div className="receipt-line" key={l.id}>
                    <div>
                      <strong>{l.name}</strong>
                      <small>
                        {l.quantity} item(s) · {l.status}
                      </small>
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
