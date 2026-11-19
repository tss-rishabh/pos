import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ChevronDown, Pencil, RefreshCw } from 'lucide-react';
import { params, request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { Modal } from '../../components/modal';
import { currency } from '../../lib/format';
import './style.css';

const tabs = [
  ['in_queue', 'In queue', ['PENDING']],
  ['not_packed', 'To pack', ['ACCEPTED']],
  ['packed', 'Packed', ['PACKED']],
  ['shipped', 'Shipped', ['OUT_FOR_DELIVERY', 'DELIVERED', 'RTO']],
  ['rejected', 'Rejected', ['REJECTED', 'TIMED_OUT']],
] as const;
type Tab = (typeof tabs)[number][0];
const line = z.object({
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
  pendingExpiresAt: z.string().nullable(),
  acceptedExpiresAt: z.string().nullable(),
});
const order = z.object({
  orderId: z.string(),
  storeId: z.string(),
  storeName: z.string(),
  reference: z.string(),
  userId: z.string().nullable(),
  customerName: z.string(),
  paymentStatus: z.string().nullable(),
  orderStatus: z.string().nullable(),
  createdAt: z.string().nullable(),
  isSplit: z.boolean(),
  packedAt: z.string().nullable(),
  packedSeconds: z.number().nullable(),
  storeOrderAmount: z.number(),
  lines: z.array(line),
});
type Order = z.infer<typeof order>;
const result = z.object({
  tabCounts: z.record(z.string(), z.number()),
  data: z.array(order),
  page: z.number(),
  totalPages: z.number(),
  total: z.number(),
  hasPrevious: z.boolean(),
  hasNext: z.boolean(),
  pageRange: z.array(z.number()),
});
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
function duration(seconds: number) {
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${Math.floor(seconds % 60)}s`;
}
export function FulfillmentMonitoringPage({ user, storeId }: { user: Principal; storeId: string }) {
  const client = useQueryClient(),
    [from, setFrom] = useState(today),
    [to, setTo] = useState(today),
    [selectedStores, setStores] = useState<string[]>([]),
    [orderIds, setOrderIds] = useState(''),
    [tab, setTab] = useState<Tab>('in_queue'),
    [subStatuses, setSubStatuses] = useState<string[]>([]),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25),
    [expanded, setExpanded] = useState<string[]>([]),
    [edit, setEdit] = useState<Order | null>(null),
    [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setPage(1);
    setExpanded([]);
  }, [from, to, selectedStores, orderIds, tab, subStatuses, pageSize]);
  // Opening the dashboard resets to today and the checked-in store, as the legacy first GET
  // does (`HLGlobalFilters.initial_for_user`); later filter changes stay for this visit.
  const defaults = useQuery({
    queryKey: [user.id, 'fulfillment-monitor-defaults', storeId],
    queryFn: () =>
      request(
        '/api/v1/fulfillment/store-monitoring/defaults',
        {},
        z.object({ from: z.string(), to: z.string(), storeIds: z.array(z.string()) }),
      ),
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!defaults.data) return;
    setFrom(defaults.data.from);
    setTo(defaults.data.to);
    setStores(defaults.data.storeIds);
  }, [defaults.data]);
  const stores = useQuery({
    queryKey: [user.id, 'fulfillment-monitor-stores'],
    queryFn: () =>
      request(
        '/api/v1/fulfillment/store-monitoring/stores',
        {},
        z.object({
          data: z.array(
            z.object({
              id: z.string(),
              name: z.string().nullable(),
              locationCode: z.string().nullable(),
              active: z.boolean(),
            }),
          ),
        }),
      ),
  });
  const query = useQuery({
    queryKey: [
      user.id,
      'fulfillment-monitor',
      from,
      to,
      selectedStores,
      orderIds,
      tab,
      subStatuses,
      page,
      pageSize,
    ],
    enabled: !defaults.isPending,
    queryFn: () =>
      request(
        `/api/v1/fulfillment/store-monitoring?${params({ from, to, orderIds: orderIds.replace(/\s/g, ''), tab, subStatuses: subStatuses.join(','), page: String(page), pageSize: String(pageSize) })}`,
        {},
        result,
      ),
    refetchInterval: from === today() && to === today() ? 15000 : false,
  });
  useEffect(() => {
    setElapsed(0);
    if (tab !== 'packed') return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [tab, query.dataUpdatedAt]);
  const reset = async () => {
    await client.invalidateQueries({ queryKey: [user.id, 'fulfillment-monitor'] });
  };
  return (
    <>
      <PageTitle title="Store fulfillment monitor">
        <button className="button secondary" onClick={() => void query.refetch()}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </PageTitle>
      <div className="surface monitor-filters">
        <label>
          From
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <label>
          Stores
          <select
            multiple
            value={selectedStores}
            onChange={(event) => {
              const storeIds = Array.from(event.target.selectedOptions, (option) => option.value);
              // Legacy keeps the selection in the login session (`hla_store_ids`).
              void request(
                '/api/v1/fulfillment/store-monitoring/selection',
                { method: 'PUT', body: JSON.stringify({ storeIds }) },
                z.object({ storeIds: z.array(z.string()) }),
              ).then(
                (saved) => setStores(saved.storeIds),
                () => undefined,
              );
            }}
          >
            {stores.data?.data.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name || store.id}
                {store.active ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
          <small>Clear the selection to include all stores you can access.</small>
        </label>
        <label>
          Order IDs
          <input
            placeholder="1001, 1002"
            value={orderIds}
            onChange={(event) => setOrderIds(event.target.value)}
            maxLength={10000}
          />
        </label>
        <label>
          Rows
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            {[10, 25, 50, 100, 500].map((size) => (
              <option key={size}>{size}</option>
            ))}
          </select>
        </label>
      </div>
      {stores.isError && <ErrorState error={stores.error} />}
      <div className="fulfillment-tabs" role="tablist" aria-label="Network fulfillment stage">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'selected' : ''}
            onClick={() => {
              setTab(value);
              setSubStatuses([]);
            }}
          >
            {label}
            <span>{query.data?.tabCounts[value] || 0}</span>
          </button>
        ))}
      </div>
      <div className="monitor-status-filter">
        {tabs
          .find((item) => item[0] === tab)?.[2]
          .map((status) => (
            <label key={status}>
              <input
                type="checkbox"
                checked={subStatuses.includes(status)}
                onChange={(event) =>
                  setSubStatuses((values) =>
                    event.target.checked
                      ? [...values, status]
                      : values.filter((value) => value !== status),
                  )
                }
              />
              {status.replaceAll('_', ' ')}
            </label>
          ))}
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <Empty title="No matching orders">Adjust the stores, dates, or status filters.</Empty>
      ) : (
        <>
          <div className="surface monitor-table">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Payment</th>
                  <th>Amount</th>
                  <th>Order status</th>
                  <th>Created</th>
                  <th>Store</th>
                  <th>Item status</th>
                  {tab === 'packed' && <th>Packed for</th>}
                  {user.role === 1 && <th>Manage</th>}
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((item) => {
                  const key = `${item.orderId}:${item.storeId}`,
                    open = expanded.includes(key);
                  return (
                    <MonitorRow
                      key={key}
                      item={item}
                      expanded={open}
                      toggle={() =>
                        setExpanded((values) =>
                          open ? values.filter((value) => value !== key) : [...values, key],
                        )
                      }
                      tab={tab}
                      elapsed={elapsed}
                      canEdit={user.role === 1}
                      edit={() => setEdit(item)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="fulfillment-pagination">
            <button
              className="button secondary"
              disabled={!query.data.hasPrevious}
              onClick={() => setPage(query.data.page - 1)}
            >
              Previous
            </button>
            <span>
              {query.data.total} order/store rows · Page {query.data.page} of{' '}
              {query.data.totalPages}
            </span>
            <button
              className="button secondary"
              disabled={!query.data.hasNext}
              onClick={() => setPage(query.data.page + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
      {edit && <AdminEdit item={edit} user={user} close={() => setEdit(null)} saved={reset} />}
    </>
  );
}
function MonitorRow({
  item,
  expanded,
  toggle,
  tab,
  elapsed,
  canEdit,
  edit,
}: {
  item: Order;
  expanded: boolean;
  toggle: () => void;
  tab: Tab;
  elapsed: number;
  canEdit: boolean;
  edit: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <button
            className="icon-button"
            onClick={toggle}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} order ${item.orderId}`}
          >
            <ChevronDown size={16} />
          </button>
        </td>
        <td>
          <strong>#{item.orderId}</strong>
          {item.isSplit && <small className="badge neutral">Split</small>}
        </td>
        <td>
          {item.customerName}
          <small>User {item.userId || '—'}</small>
        </td>
        <td>{item.paymentStatus || '—'}</td>
        <td>{currency(item.storeOrderAmount)}</td>
        <td>{item.orderStatus || '—'}</td>
        <td>{item.createdAt || '—'}</td>
        <td>{item.storeName}</td>
        <td>{item.lines[0]?.status?.replaceAll('_', ' ') || '—'}</td>
        {tab === 'packed' && (
          <td title={item.packedAt || undefined}>
            {item.packedSeconds === null ? '—' : duration(item.packedSeconds + elapsed)}
          </td>
        )}
        {canEdit && (
          <td>
            <button
              className="icon-button"
              onClick={edit}
              aria-label={`Edit order ${item.orderId}`}
            >
              <Pencil size={16} />
            </button>
          </td>
        )}
      </tr>
      {expanded && (
        <tr>
          <td colSpan={12}>
            <div className="monitor-line-items">
              {item.lines.map((line) => (
                <div key={line.id}>
                  {line.image && (
                    <a href={line.image} target="_blank" rel="noreferrer">
                      <img src={line.image} alt={line.productName || 'Product'} loading="lazy" />
                    </a>
                  )}
                  <div>
                    <strong>{line.productName || 'Missing product'}</strong>
                    <small>
                      SKU {line.productId || '—'} · Line {line.hasProductId}
                    </small>
                  </div>
                  <span>
                    {line.quantity || '0'} × ₹{line.price || '0'} · GST {line.gst || 0}%
                  </span>
                  <span className="badge neutral">{line.status}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
function AdminEdit({
  item,
  user,
  close,
  saved,
}: {
  item: Order;
  user: Principal;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [status, setStatus] = useState(item.lines[0]?.status || ''),
    [pending, setPending] = useState(
      (item.lines[0]?.pendingExpiresAt || '').slice(0, 16).replace(' ', 'T'),
    ),
    [accepted, setAccepted] = useState(
      (item.lines[0]?.acceptedExpiresAt || '').slice(0, 16).replace(' ', 'T'),
    );
  const mutation = useMutation({
    mutationFn: () =>
      request(
        `/api/v1/stores/${item.storeId}/fulfillment/orders/${item.orderId}`,
        {
          method: 'PATCH',
          operatorId: user.id,
          body: JSON.stringify({
            ...(status ? { status } : {}),
            ...(pending ? { pendingExpiresAt: pending } : {}),
            ...(accepted ? { acceptedExpiresAt: accepted } : {}),
          }),
        },
        z.object({ updatedCount: z.number() }),
      ),
    onSuccess: async () => {
      await saved();
      close();
    },
  });
  return (
    <Modal
      size="sm"
      title={`Edit order ${item.orderId}`}
      description={`${item.storeName} · Changes apply to this store’s lines and are recorded in the status history.`}
      closeLabel="Close editor"
      onClose={close}
      footer={
        <button
          className="button primary"
          disabled={mutation.isPending}
          aria-busy={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Save changes
        </button>
      }
    >
      <label>
        Status
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {[
            'PENDING',
            'ACCEPTED',
            'REJECTED',
            'PACKED',
            'OUT_FOR_DELIVERY',
            'DELIVERED',
            'RTO',
            'TIMED_OUT',
          ].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <label>
        Acceptance deadline
        <input
          type="datetime-local"
          value={pending}
          onChange={(event) => setPending(event.target.value)}
        />
      </label>
      <label>
        Packing deadline
        <input
          type="datetime-local"
          value={accepted}
          onChange={(event) => setAccepted(event.target.value)}
        />
      </label>
      {mutation.isError && <ErrorState error={mutation.error} />}
    </Modal>
  );
}
