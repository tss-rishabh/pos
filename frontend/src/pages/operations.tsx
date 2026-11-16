import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Building2, CheckCircle2, Search, X } from 'lucide-react';
import type { Principal, Store } from '../api/types';
import { useOnline, useOrders, useProducts } from '../hooks/use-pos';
import { currency } from '../lib/format';
import { Empty, ErrorState, Loading, Metric, PageTitle } from '../components/common';
import { request } from '../api/client';
import { orderDetailSchema } from '../api/schemas';
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
    [automaticInvoice, setAutomaticInvoice] = useState<AutomaticInvoiceRequest | null>(null);
  const orders = useOrders(user.id, storeId),
    rows = orders.data?.pages.flatMap((p) => p.data) || [];
  const [searchParams, setSearchParams] = useSearchParams(),
    location = useLocation(),
    scope = { operatorId: user.id, storeId },
    link = orderLink(searchParams, location.state as unknown, scope),
    selected = link.needsBinding ? '' : link.id;
  useEffect(() => setAutomaticInvoice(null), [user.id, storeId, selected]);
  const setSelected = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('orderId', id);
    else next.delete('orderId');
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
    queryKey: [user.id, 'order', storeId, selected],
    enabled: !!selected,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/stores/${storeId}/orders/${selected}`,
        { operatorId: user.id, signal },
        orderDetailSchema,
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
      {link.invalid && (
        <p className="inline-error" role="alert">
          The order link contains an invalid reference.
        </p>
      )}
      <section className="surface">
        <div className="surface-title">
          <h2>Store orders</h2>
          <span className="muted">Most recent first</span>
        </div>
        {orders.isPending ? (
          <Loading />
        ) : orders.isError ? (
          <ErrorState error={orders.error} retry={() => void orders.refetch()} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Placed</th>
                  <th>Amount</th>
                  <th>Payment</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <button className="text-button" onClick={() => setSelected(o.id)}>
                        {o.reference || o.id}
                      </button>
                    </td>
                    <td>{o.customer}</td>
                    <td>
                      {new Date(o.createdAt).toLocaleString('en-IN', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td>
                      <strong>{currency(o.amount)}</strong>
                    </td>
                    <td>
                      <span className="badge green">{o.paymentStatus}</span>
                    </td>
                    <td>{o.status}</td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`View order ${o.reference}`}
                        onClick={() => setSelected(o.id)}
                      >
                        <ArrowUpRight size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <Empty title="No orders yet" />}
          </div>
        )}
        {orders.hasNextPage && (
          <button
            className="button secondary load-more"
            onClick={() => void orders.fetchNextPage()}
          >
            Load more orders
          </button>
        )}
      </section>
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
            {detail.isPending ? (
              <Loading />
            ) : detail.isError ? (
              <ErrorState error={detail.error} />
            ) : (
              <>
                <p>
                  {detail.data?.status} · {currency(detail.data?.amount || 0)}
                </p>
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
                  key={`${user.id}:${storeId}:${selected}`}
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
