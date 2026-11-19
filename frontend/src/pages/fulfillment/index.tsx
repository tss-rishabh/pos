import { useEffect, useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Clock3,
  PackageCheck,
  RefreshCw,
  Truck,
  Undo2,
  X,
} from 'lucide-react';
import { params, request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { currency } from '../../lib/format';
import { useOnline } from '../../hooks/use-pos';
import { InvoiceDocumentAction } from '../invoice-documents/document';
import './style.css';
import { sendFulfillmentCommand, type FulfillmentAction } from './commands';
import { ShippingLabelAction } from './shipping-label';
import { useFulfillmentExpiryAlerts } from './expiry-alerts';

/** Legacy hyperlocal progress page (`order/templates/order/hyperlocal/progress.html`). */
const tabs = [
  ['in_queue', 'In queue'],
  ['not_packed', 'Not packed'],
  ['packed', 'Packed'],
  ['shipped', 'Shipped'],
] as const;
type Tab = (typeof tabs)[number][0];
const lineSchema = z.object({
  id: z.string(),
  hasProductId: z.string(),
  productId: z.string().nullable(),
  parentProductId: z.string().nullable(),
  productName: z.string().nullable(),
  image: z.string().nullable(),
  price: z.string().nullable(),
  quantity: z.string().nullable(),
  gst: z.number().nullable(),
  status: z.string().nullable(),
});
const orderSchema = z.object({
  id: z.string(),
  userId: z.string(),
  customerName: z.string(),
  paymentStatus: z.string().nullable(),
  orderStatus: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lines: z.array(lineSchema),
  storeOrderAmount: z.number(),
  isVincAllocated: z.boolean(),
  hasShipmentId: z.boolean(),
  hasAwb: z.boolean(),
  isRto: z.boolean(),
  canMarkRto: z.boolean(),
  isTimedOut: z.boolean(),
});
type Order = z.infer<typeof orderSchema>;
const pageSchema = z.object({
  storeId: z.string().nullable(),
  data: z.array(orderSchema),
  hasMore: z.boolean(),
  nextOffset: z.number(),
  orderIds: z.array(z.string()),
});
const progressSchema = z.object({
  storeId: z.string().nullable(),
  tabCounts: z.record(z.string(), z.number()),
  orderIds: z.record(z.string(), z.array(z.string())),
  pollIntervalMs: z.number(),
});

/** Legacy countdown text (`progress.html:500-536`): `h:mm:ss`, `m:ss`, or EXPIRED. */
export function countdown(expiresAt: string, now: number) {
  const target = new Date(expiresAt.replace(' ', 'T')).getTime(),
    remaining = target - now;
  if (Number.isNaN(target) || remaining <= 0)
    return { text: 'EXPIRED', tone: 'red', expired: true };
  const total = Math.floor(remaining / 1000),
    hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    seconds = total % 60;
  const text =
    (hours > 0 ? `${hours}:${minutes < 10 ? '0' : ''}` : '') +
    `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  return {
    text,
    tone: remaining < 120000 ? 'red' : remaining < 300000 ? 'amber' : 'green',
    expired: false,
  };
}
function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

export function FulfillmentPage({ user, storeId }: { user: Principal; storeId: string }) {
  const client = useQueryClient();
  const online = useOnline();
  const [search, setSearch] = useSearchParams();
  const requested = search.getAll('tab');
  const tab: Tab =
    requested.length === 1
      ? (tabs.find(([value]) => value === requested[0])?.[0] ?? 'in_queue')
      : 'in_queue';
  const setTab = (value: Tab) => {
    const next = new URLSearchParams(search);
    next.set('tab', value);
    setSearch(next);
  };
  const [notice, setNotice] = useState(''),
    [reject, setReject] = useState<{ orderId: string; storeId: string } | null>(null),
    [reason, setReason] = useState(''),
    [expanded, setExpanded] = useState<string | null>(null),
    [, setKnown] = useState<string[] | null>(null),
    [hasNew, setHasNew] = useState(false);
  useEffect(() => {
    setNotice('');
    setReject(null);
    setReason('');
    setKnown(null);
    setHasNew(false);
  }, [user.id, tab]);
  const progress = useQuery({
    queryKey: [user.id, 'fulfillment-progress', tab],
    queryFn: () => request(`/api/v1/fulfillment/progress?${params({ tab })}`, {}, progressSchema),
    refetchInterval: (query) => query.state.data?.pollIntervalMs ?? 100000,
  });
  const page = useInfiniteQuery({
    queryKey: [user.id, 'fulfillment-orders', tab],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      request(
        `/api/v1/fulfillment/progress/orders?${params({ tab, offset: String(pageParam) })}`,
        {},
        pageSchema,
      ),
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
  });
  const checkInStore = progress.data?.storeId ?? page.data?.pages[0]?.storeId ?? null;
  // Legacy polling keeps the rendered cards and only reports genuinely new orders
  // (`progress.html:546-584`); cards that left the tab disappear on refresh.
  const fresh = progress.data?.orderIds[tab],
    freshKey = fresh?.join(',');
  useEffect(() => {
    if (freshKey === undefined) return;
    const ids = freshKey ? freshKey.split(',') : [];
    setKnown((previous) => {
      if (previous && ids.some((id) => !previous.includes(id))) setHasNew(true);
      return ids;
    });
  }, [freshKey]);
  const orders = (page.data?.pages.flatMap((item) => item.data) ?? []).filter(
    (order) => !fresh || fresh.includes(order.id),
  );
  const reasons = useQuery({
    queryKey: [user.id, 'fulfillment-rejection-reasons'],
    enabled: !!reject,
    queryFn: () =>
      request(
        '/api/v1/fulfillment/rejection-reasons',
        {},
        z.object({ data: z.array(z.object({ id: z.string(), reason: z.string() })) }),
      ),
  });
  const alerts = useFulfillmentExpiryAlerts(user.id, storeId, !!storeId && online);
  const now = useNow(tab === 'in_queue' || tab === 'not_packed');
  const action = useMutation({
    mutationFn: (input: {
      storeId: string;
      orderId: string;
      action: FulfillmentAction;
      rejectionReasonId?: string;
    }) => sendFulfillmentCommand(user.id, input),
    onSuccess: async (result) => {
      setReject(null);
      setReason('');
      setNotice(`${result.message}: updated ${result.updatedCount} item(s).`);
      await client.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === user.id &&
          typeof query.queryKey[1] === 'string' &&
          query.queryKey[1].startsWith('fulfillment-'),
      });
    },
  });
  const refresh = () => {
    setHasNew(false);
    void progress.refetch();
    void page.refetch();
  };
  function actions(order: Order, expired: boolean) {
    const store = checkInStore!;
    const run = (kind: FulfillmentAction) =>
      action.mutate({ storeId: store, orderId: order.id, action: kind });
    const disabled = action.isPending || !online;
    // Legacy card buttons (`_order_cards.html:115-190`).
    if (tab === 'in_queue') {
      if (order.isTimedOut)
        return <span className="badge red">Expired – Waiting for Allocation</span>;
      if (!order.isVincAllocated)
        return <span className="badge amber">Waiting for Allocation</span>;
      return (
        <>
          <button
            className="button primary"
            disabled={disabled || expired}
            title={expired ? 'The acceptance window for this order has expired.' : undefined}
            onClick={() => run('acceptance')}
          >
            <Check size={15} />
            Accept
          </button>
          <button
            className="button secondary"
            disabled={disabled || expired}
            onClick={() => setReject({ orderId: order.id, storeId: store })}
          >
            <X size={15} />
            Reject
          </button>
        </>
      );
    }
    if (tab === 'not_packed')
      return order.hasShipmentId ? (
        <button
          className="button primary"
          disabled={disabled || expired}
          onClick={() => run('packing')}
        >
          <PackageCheck size={15} />
          Mark Packed
        </button>
      ) : (
        <button className="button secondary" disabled>
          <Clock3 size={15} />
          Waiting for Shipment ID
        </button>
      );
    if (tab === 'packed')
      return (
        <>
          <InvoiceDocumentAction
            user={user}
            storeId={store}
            orderId={order.id}
            kind="express"
            online={online}
          />
          {order.hasAwb ? (
            <>
              <ShippingLabelAction user={user} storeId={store} orderId={order.id} online={online} />
              <button
                className="button primary"
                disabled={disabled}
                onClick={() => run('shipment')}
              >
                <Truck size={15} />
                Mark Shipped
              </button>
            </>
          ) : (
            <button className="button secondary" disabled>
              <Clock3 size={15} />
              Waiting for AWB
            </button>
          )}
        </>
      );
    if (order.canMarkRto)
      return (
        <button className="button secondary" disabled={disabled} onClick={() => run('rto-receipt')}>
          <Undo2 size={15} />
          Mark as RTO
        </button>
      );
    if (order.isRto) return <span className="badge neutral">RTO Done</span>;
    return null;
  }
  return (
    <>
      <PageTitle title="Hyperlocal progress">
        <NavLink className="button secondary" to="/local-deliveries">
          Local deliveries
        </NavLink>
        <button className="button secondary" onClick={refresh}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </PageTitle>
      {progress.isSuccess && !checkInStore && (
        <p role="status" className="fulfillment-status">
          <AlertCircle size={15} />
          Check in to a store to see its hyperlocal orders.
        </p>
      )}
      <div className="fulfillment-tabs" role="tablist" aria-label="Fulfillment status">
        {tabs.map(([value, label]) => (
          <button
            role="tab"
            aria-selected={value === tab}
            className={value === tab ? 'selected' : ''}
            key={value}
            onClick={() => setTab(value)}
          >
            {label}
            <span>{progress.data?.tabCounts[value] ?? 0}</span>
          </button>
        ))}
      </div>
      {hasNew && (
        <div className="fulfillment-status" role="status">
          <AlertCircle size={16} />
          New orders have arrived.
          <button className="button secondary" onClick={refresh}>
            Refresh
          </button>
        </div>
      )}
      {!!alerts.data?.expiringSoon.length && (
        <div className="fulfillment-status" role="status">
          <AlertCircle size={16} />
          {alerts.data.expiringSoon.length} order deadline(s) within 35 minutes.
        </div>
      )}
      {notice && (
        <p role="status" className="fulfillment-status">
          <Check size={15} />
          {notice}
        </p>
      )}
      {action.isError && <ErrorState error={action.error} />}
      {page.isPending ? (
        <Loading />
      ) : page.isError ? (
        <ErrorState error={page.error} retry={() => void page.refetch()} />
      ) : orders.length === 0 ? (
        <Empty title="No orders found for this tab." />
      ) : (
        <div className="surface monitor-table">
          <table>
            <thead>
              <tr>
                <th>Order ID</th>
                <th>User ID</th>
                <th>Name</th>
                <th>Pay Status</th>
                <th>Amount</th>
                <th>Order Status</th>
                <th>Order Date</th>
                {(tab === 'in_queue' || tab === 'not_packed') && <th>Expires In</th>}
                <th>Actions</th>
              </tr>
            </thead>
            {orders.map((order) => {
              const timer =
                order.expiresAt && (tab === 'in_queue' || tab === 'not_packed')
                  ? countdown(order.expiresAt, now)
                  : null;
              return (
                <tbody key={order.id}>
                  <tr>
                    <td>
                      <button
                        className="icon-button"
                        aria-expanded={expanded === order.id}
                        aria-label={`Show items of order ${order.id}`}
                        onClick={() => setExpanded(expanded === order.id ? null : order.id)}
                      >
                        <ChevronDown size={14} />
                      </button>
                      <strong>#{order.id}</strong>
                    </td>
                    <td>{order.userId}</td>
                    <td>{order.customerName}</td>
                    <td>
                      <span
                        className={`badge ${order.paymentStatus === 'Paid' ? 'green' : 'amber'}`}
                      >
                        {order.paymentStatus}
                      </span>
                    </td>
                    <td>{currency(Math.round(order.storeOrderAmount))}</td>
                    <td>
                      <span className="badge neutral">{order.orderStatus}</span>
                    </td>
                    <td>{order.createdAt}</td>
                    {(tab === 'in_queue' || tab === 'not_packed') && (
                      <td>
                        {order.isTimedOut ? (
                          <span className="badge red">EXPIRED</span>
                        ) : timer ? (
                          <span className={`badge ${timer.tone}`}>{timer.text}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                    <td className="fulfillment-flags">{actions(order, Boolean(timer?.expired))}</td>
                  </tr>
                  {expanded === order.id && (
                    <tr>
                      <td colSpan={9}>
                        <div className="monitor-line-items">
                          {order.lines.length === 0 && <small>No line items found.</small>}
                          {order.lines.map((line) => (
                            <div key={line.id}>
                              <small>{line.hasProductId}</small>
                              <small>{line.productId}</small>
                              {line.image ? (
                                <img src={line.image} alt="" loading="lazy" />
                              ) : (
                                <small>No img</small>
                              )}
                              <div>
                                {line.productId ? (
                                  <Link
                                    to={`/catalog/products/${
                                      line.parentProductId && line.parentProductId !== '0'
                                        ? line.parentProductId
                                        : line.productId
                                    }`}
                                  >
                                    {line.productName}
                                  </Link>
                                ) : (
                                  line.productName
                                )}
                                <small>
                                  ₹{line.price} · Qty {line.quantity} · GST {line.gst}%
                                </small>
                              </div>
                              <span className="badge neutral">{line.status}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
          </table>
        </div>
      )}
      {page.hasNextPage && (
        <div className="fulfillment-pagination">
          <button
            className="button secondary"
            disabled={page.isFetchingNextPage}
            onClick={() => void page.fetchNextPage()}
          >
            <ChevronDown size={15} />
            Load More Orders
          </button>
        </div>
      )}
      {reject && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="reject-title">
            <button
              className="icon-button modal-close"
              aria-label="Cancel rejection"
              onClick={() => setReject(null)}
            >
              <X size={20} />
            </button>
            <h2 id="reject-title">Reject order {reject.orderId}?</h2>
            <label>
              Select a reason for rejection:
              <select
                aria-label="Rejection reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              >
                <option value="">Choose a reason</option>
                {reasons.data?.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.reason}
                  </option>
                ))}
              </select>
            </label>
            {reasons.isError && <ErrorState error={reasons.error} />}
            <button
              className="button primary full"
              disabled={!reason || action.isPending}
              onClick={() =>
                action.mutate({ ...reject, action: 'rejection', rejectionReasonId: reason })
              }
            >
              <AlertCircle size={16} />
              Reject
            </button>
          </section>
        </div>
      )}
    </>
  );
}
