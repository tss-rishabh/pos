import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router-dom';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading } from '../../components/common';
import { currency } from '../../lib/format';
import { OrderInvoiceActions } from '../invoice-documents';
import {
  useOrderSearchOptions,
  type OrderDefaultRanges,
  type OrderSearchMetadata,
  searchOrders,
  sourcePageCsv,
  type OrderSearchBody,
  type SearchSort,
  type SourceOrderRow,
} from './search-client';
import './order-search.css';
import { onlineOrderDetailLink } from './online-detail-client';
const titles = { ST: 'Store', HL: 'Local delivery', HE: 'Express', N: 'Online' } as const;
const columns: [keyof SourceOrderRow, string, SearchSort?][] = [
  ['id', 'Order', 'id'],
  ['user_id', 'Customer ID', 'user_id'],
  ['user__firstname', 'Customer', 'user__firstname'],
  ['payment_statuses__payment_status', 'Payment status'],
  ['payment_methods__name', 'Payment method'],
  ['order_amt', 'Order amount', 'order_amt'],
  ['order_statuses', 'Order status', 'order_statuses'],
  ['created_at', 'Placed', 'created_at'],
  ['store_name', 'Store'],
  ['location_code', 'Location'],
];
export function SourceOrderList({
  user,
  storeId,
  dates,
  online,
  refreshToken = 0,
  defaults,
  options: providedOptions,
  view = 'store',
  onOpen,
}: {
  user: Principal;
  storeId: string;
  dates: { from: string; to: string; explicit?: boolean };
  defaults?: OrderDefaultRanges;
  options?: OrderSearchMetadata;
  online: boolean;
  refreshToken?: number;
  /** `online` is legacy `orders/online/`: Local delivery type with an empty date range. */
  view?: 'store' | 'online';
  /** `crossAccess` mirrors the legacy `?cr=1` link from an order-ID search. */
  onOpen: (row: SourceOrderRow, options: { crossAccess: boolean }) => void;
}) {
  const onlineView = view === 'online';
  const initialRange =
    !onlineView && defaults && dates.explicit === false ? defaults.store : undefined;
  const localTime = (value: string) => value.replace(' ', 'T').slice(0, 16);
  const [form, setForm] = useState({
      type: (onlineView ? 'HL' : 'ST') as OrderSearchBody['orderType'],
      stores: [storeId],
      ids: '',
      idsAcrossDates: false,
      mobile: '',
      email: '',
      methods: [] as string[],
      payments: [] as string[],
      statuses: [] as string[],
      search: '',
      notPacked: false,
      inQueue: false,
      placedFrom: initialRange ? localTime(initialRange.placedFrom) : '',
      placedTo: initialRange ? localTime(initialRange.placedTo) : '',
    }),
    [visible, setVisible] = useState(() => columns.map(([key]) => key)),
    [error, setError] = useState(''),
    [summary, setSummary] = useState<SourceOrderRow | null>(null),
    [selection, setSelection] = useState<{ id: string; body: OrderSearchBody }>(() => ({
      id: crypto.randomUUID(),
      body: {
        orderType: onlineView ? 'HL' : 'ST',
        storeIds: [storeId],
        orderIds: [],
        ...(onlineView ? {} : { from: dates.from, to: dates.to }),
        ...initialRange,
        mobile: '',
        email: '',
        paymentMethodIds: [],
        paymentStatusIds: [],
        orderStatusIds: [],
        notPacked: false,
        inQueue: false,
        search: '',
        sort: { field: 'id', direction: 'desc' },
        page: 1,
        pageSize: 25,
        draw: 1,
      },
    }));
  const metadataQuery = useOrderSearchOptions(user, storeId, online && !providedOptions);
  const metadata = { ...metadataQuery, data: providedOptions ?? metadataQuery.data };
  const previous = useRef({
    dates: JSON.stringify([dates.from, dates.to, dates.explicit]),
    refreshToken,
  });
  useEffect(() => {
    const key = JSON.stringify([dates.from, dates.to, dates.explicit]);
    const calendarChanged = previous.current.dates !== key;
    if (!calendarChanged && previous.current.refreshToken === refreshToken) return;
    previous.current = { dates: key, refreshToken };
    if (calendarChanged) {
      setForm((old) => ({ ...old, placedFrom: '', placedTo: '' }));
    }
    if (onlineView && !dates.explicit) return;
    setSelection((old) => ({
      id: crypto.randomUUID(),
      body: {
        ...old.body,
        from: dates.from,
        to: dates.to,
        ...(calendarChanged ? { placedFrom: undefined, placedTo: undefined } : {}),
        page: 1,
        draw: old.body.draw + 1,
      },
    }));
    setSummary(null);
  }, [dates.from, dates.to, dates.explicit, refreshToken]);
  const orders = useQuery({
    queryKey: [user.id, 'order-search', storeId, selection.id],
    enabled: online,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    queryFn: ({ signal }) => searchOrders(user.id, storeId, selection.body, signal),
  });
  const data = orders.data;
  const appliedType =
    selection.body.inQueue || selection.body.notPacked ? 'HL' : selection.body.orderType;
  function apply(next: OrderSearchBody) {
    setError('');
    setSummary(null);
    setSelection((old) => ({
      id: crypto.randomUUID(),
      body: { ...next, draw: old.body.draw + 1 },
    }));
  }
  function submit() {
    if (form.type === 'HE' && !form.inQueue && !form.notPacked && form.stores.length !== 1) {
      setError('Select exactly one store for Express orders.');
      return;
    }
    const ids = form.ids.trim()
      ? form.ids
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    if (ids.length > 1000 || ids.some((value) => !/^[1-9]\d{0,18}$/.test(value))) {
      setError('Enter up to 1,000 comma-separated order IDs.');
      return;
    }
    if (Boolean(form.placedFrom) !== Boolean(form.placedTo)) {
      setError('Supply both placement timestamps.');
      return;
    }
    const precise =
      !form.notPacked && !form.inQueue && form.placedFrom && form.placedTo
        ? {
            placedFrom: form.placedFrom.replace('T', ' ') + ':00',
            placedTo: form.placedTo.replace('T', ' ') + ':00',
          }
        : {};
    // The Online page has no default window (legacy `OnlineOrdersView.get`).
    const from = form.placedFrom?.slice(0, 10) || (onlineView ? undefined : dates.from),
      to = form.placedTo?.slice(0, 10) || (onlineView ? undefined : dates.to);
    apply({
      ...selection.body,
      placedFrom: undefined,
      placedTo: undefined,
      orderType: form.type,
      storeIds: form.stores,
      orderIds: ids,
      from: form.idsAcrossDates && ids.length ? undefined : from,
      to: form.idsAcrossDates && ids.length ? undefined : to,
      ...(form.idsAcrossDates && ids.length ? {} : precise),
      mobile: form.mobile,
      email: form.email,
      paymentMethodIds: form.methods,
      paymentStatusIds: form.payments,
      orderStatusIds: form.statuses,
      notPacked: form.notPacked,
      inQueue: form.inQueue,
      search: form.search,
      page: 1,
    });
  }
  const select = (event: React.ChangeEvent<HTMLSelectElement>) =>
      Array.from(event.currentTarget.selectedOptions, (option) => option.value),
    queue = form.notPacked || form.inQueue;
  function detailLink(row: SourceOrderRow) {
    const type = appliedType;
    if (type === 'ST') throw new Error('Use the store-order detail path.');
    return onlineOrderDetailLink(
      user,
      type === 'HE'
        ? (selection.body.storeIds[0] ?? metadata.data?.checkedInStoreId ?? storeId)
        : storeId,
      row.id,
      type,
    );
  }
  function exportPage() {
    if (!data) return;
    const blob = new Blob([sourcePageCsv(data.data, visible)], { type: 'text/csv;charset=utf-8' }),
      url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = 'orders-page.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const total = BigInt(data?.recordsFiltered ?? '0'),
    pages = (total + BigInt(selection.body.pageSize) - 1n) / BigInt(selection.body.pageSize),
    page = data?.page ?? selection.body.page;
  const tabs = metadata.data?.hyperlocalTabs;
  return (
    <section className="surface order-search-workspace">
      {tabs && (
        <nav aria-label="Hyperlocal order tabs" className="order-search-actions">
          {(
            [
              ['in_queue', 'Order In Queue', tabs.inQueue],
              ['not_packed', 'Not Packed', tabs.notPacked],
              ['packed', 'Packed', tabs.packed],
              ['shipped', 'Shipped', tabs.shipped],
            ] as const
          ).map(([tab, label, count]) => (
            <NavLink key={tab} className="button secondary" to={'/fulfillment?tab=' + tab}>
              {label} : <strong>{count}</strong>
            </NavLink>
          ))}
        </nav>
      )}
      <form
        aria-label="Order filters"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="order-search-grid">
          <label>
            Order type
            <select
              aria-label="Order type"
              value={form.type}
              onChange={(e) => {
                const type = e.currentTarget.value as OrderSearchBody['orderType'];
                // Original radio controls retain the current placement window.
                setForm((old) => ({ ...old, type }));
              }}
            >
              {(
                metadata.data?.orderTypes ??
                (user.userType === 1 ? ['ST', 'HL', 'HE', 'N'] : ['ST', 'HL', 'HE'])
              ).map((type) => (
                <option key={type} value={type}>
                  {titles[type as keyof typeof titles]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Stores
            <select
              multiple
              aria-label="Order stores"
              value={form.stores}
              onChange={(e) => setForm({ ...form, stores: select(e) })}
            >
              {(
                metadata.data?.stores ?? [{ id: storeId, name: 'Current store', locationCode: '' }]
              ).map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name ?? store.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Order IDs
            <input
              aria-label="Order IDs"
              value={form.ids}
              disabled={queue}
              onChange={(e) => setForm({ ...form, ids: e.currentTarget.value })}
              placeholder="Comma-separated IDs"
              autoComplete="off"
            />
          </label>
          <label>
            <span>Search IDs across dates</span>
            <input
              type="checkbox"
              checked={form.idsAcrossDates}
              disabled={queue}
              onChange={(e) => setForm({ ...form, idsAcrossDates: e.currentTarget.checked })}
            />
          </label>
          <label>
            Mobile
            <input
              aria-label="Order mobile"
              value={form.mobile}
              maxLength={32}
              onChange={(e) => setForm({ ...form, mobile: e.currentTarget.value })}
              autoComplete="off"
            />
          </label>
          <label>
            Email
            <input
              aria-label="Order email"
              value={form.email}
              maxLength={96}
              onChange={(e) => setForm({ ...form, email: e.currentTarget.value })}
              autoComplete="off"
            />
          </label>
          <label>
            Payment method
            <select
              multiple
              aria-label="Payment methods"
              value={form.methods}
              onChange={(e) => setForm({ ...form, methods: select(e) })}
            >
              {metadata.data?.methods.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name ?? value.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Payment status
            <select
              multiple
              aria-label="Payment statuses"
              value={form.payments}
              onChange={(e) => setForm({ ...form, payments: select(e) })}
            >
              {metadata.data?.paymentStatuses.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name ?? value.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Order status
            <select
              multiple
              aria-label="Order statuses"
              value={form.statuses}
              onChange={(e) => setForm({ ...form, statuses: select(e) })}
            >
              {metadata.data?.orderStatuses.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name ?? value.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Placed from
            <input
              type="datetime-local"
              aria-label="Placed from"
              disabled={queue}
              value={form.placedFrom}
              onChange={(e) => {
                setForm({ ...form, placedFrom: e.currentTarget.value });
              }}
            />
          </label>
          <label>
            Placed to
            <input
              type="datetime-local"
              aria-label="Placed to"
              disabled={queue}
              value={form.placedTo}
              onChange={(e) => {
                setForm({ ...form, placedTo: e.currentTarget.value });
              }}
            />
          </label>
          <label>
            Search order/customer IDs
            <input
              aria-label="Search order or customer IDs"
              value={form.search}
              maxLength={100}
              onChange={(e) => setForm({ ...form, search: e.currentTarget.value })}
            />
          </label>
        </div>
        <div className="order-search-actions">
          <label>
            <input
              type="checkbox"
              checked={form.notPacked}
              onChange={(e) => setForm({ ...form, notPacked: e.currentTarget.checked })}
            />
            Not packed
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.inQueue}
              onChange={(e) => setForm({ ...form, inQueue: e.currentTarget.checked })}
            />
            In queue
          </label>
          <button className="button primary" disabled={!online || orders.isFetching}>
            Apply filters
          </button>
        </div>
        {queue && (
          <p className="muted">
            Delivery queues use your checked-in store and ignore placement dates and explicit order
            IDs.
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
      </form>
      <div className="order-search-actions">
        <button className="button secondary" disabled={!data} onClick={exportPage}>
          Export page CSV
        </button>
        <details>
          <summary>Visible columns</summary>
          {columns.map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={visible.includes(key)}
                onChange={(e) =>
                  setVisible(
                    e.currentTarget.checked
                      ? [...visible, key]
                      : visible.filter((value) => value !== key),
                  )
                }
              />
              {label}
            </label>
          ))}
        </details>
        <label>
          Rows per page
          <select
            aria-label="Rows per page"
            value={selection.body.pageSize}
            onChange={(e) =>
              apply({ ...selection.body, pageSize: Number(e.currentTarget.value), page: 1 })
            }
          >
            {[5, 10, 25, 50, 100].map((size) => (
              <option key={size}>{size}</option>
            ))}
          </select>
        </label>
      </div>
      {metadata.isError && (
        <ErrorState error={metadata.error} retry={() => void metadata.refetch()} />
      )}
      {!online && (
        <p role="status">Offline. Loaded orders are informational; reconnect to refresh or act.</p>
      )}
      {orders.isError ? (
        <ErrorState error={orders.error} retry={() => void orders.refetch()} />
      ) : orders.isPending ? (
        online ? (
          <Loading />
        ) : (
          <Empty title="Connect to load orders" />
        )
      ) : (
        <>
          <p className="muted">
            {data?.recordsFiltered} result rows ·{' '}
            {data?.emptySelection ? 'Please select atleast one store' : 'Current orders'}
            {data?.fetchedAt ? ' · Updated ' + new Date(data.fetchedAt).toLocaleTimeString() : ''}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns
                    .filter(([key]) => visible.includes(key))
                    .map(([key, label, sort]) => (
                      <th key={key}>
                        {sort ? (
                          <button
                            className="text-button"
                            aria-label={'Sort ' + label}
                            onClick={() =>
                              apply({
                                ...selection.body,
                                page: 1,
                                sort: {
                                  field: sort,
                                  direction:
                                    selection.body.sort.field === sort &&
                                    selection.body.sort.direction === 'asc'
                                      ? 'desc'
                                      : 'asc',
                                },
                              })
                            }
                          >
                            {label}
                            {selection.body.sort.field === sort
                              ? selection.body.sort.direction === 'asc'
                                ? ' ↑'
                                : ' ↓'
                              : ''}
                          </button>
                        ) : (
                          label
                        )}
                      </th>
                    ))}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data?.data.map((row) => (
                  <tr key={row.rowKey}>
                    {columns
                      .filter(([key]) => visible.includes(key))
                      .map(([key]) => (
                        <td key={key}>
                          {key === 'order_amt' ? (
                            currency(row.order_amt)
                          ) : key === 'id' ? (
                            <>
                              <button className="text-button" onClick={() => setSummary(row)}>
                                {row.id}
                              </button>
                              {row.is_offline_order && <small>Offline order</small>}
                              {row.is_shopify_order && <small>Shopify</small>}
                              {row.is_global_order !== 0 && <small>Global</small>}
                            </>
                          ) : (
                            String(row[key] ?? '')
                          )}
                        </td>
                      ))}
                    <td>
                      {appliedType === 'ST' ? (
                        <button
                          className="text-button"
                          onClick={() =>
                            onOpen(row, { crossAccess: selection.body.orderIds.length > 0 })
                          }
                        >
                          View order {row.id}
                        </button>
                      ) : (
                        <NavLink className="text-button" to={detailLink(row)}>
                          View order {row.id}
                        </NavLink>
                      )}
                      {row.payment_methods__id === '14' &&
                        !row.is_manually_paid &&
                        ['Paid', 'Pending'].includes(row.payment_statuses__payment_status) &&
                        ['Delivered', 'Order Placed'].includes(row.order_statuses) && (
                          <small>Payment confirmation available after current verification</small>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data?.data.length && <Empty title="No orders in this selection" />}
          </div>
          <nav aria-label="Order pages" className="order-search-actions">
            <button
              className="button secondary"
              disabled={page <= 1 || !online}
              onClick={() => apply({ ...selection.body, page: 1 })}
            >
              First
            </button>
            <button
              className="button secondary"
              disabled={page <= 1 || !online}
              onClick={() => apply({ ...selection.body, page: page - 1 })}
            >
              Previous
            </button>
            <span>
              Page {page} of {pages === 0n ? '1' : pages.toString()}
            </span>
            {[-2, -1, 0, 1, 2]
              .map((delta) => page + delta)
              .filter((value) => value > 0 && value <= 2147483647 && BigInt(value) <= pages)
              .map((value) => (
                <button
                  key={value}
                  className="button secondary"
                  aria-current={value === page ? 'page' : undefined}
                  disabled={!online || value === page}
                  aria-label={'Order page ' + value}
                  onClick={() => apply({ ...selection.body, page: value })}
                >
                  {value}
                </button>
              ))}
            <button
              className="button secondary"
              disabled={BigInt(page) >= pages || !online}
              onClick={() => apply({ ...selection.body, page: page + 1 })}
            >
              Next
            </button>
            <button
              className="button secondary"
              disabled={!online || BigInt(page) >= pages || pages > 2147483647n}
              onClick={() => apply({ ...selection.body, page: Number(pages || 1n) })}
            >
              Last
            </button>
          </nav>
        </>
      )}
      {summary && (
        <div className="modal-backdrop" onClick={() => setSummary(null)}>
          <section
            className="modal wide"
            role="dialog"
            aria-modal="true"
            aria-label={'Order summary ' + summary.id}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="button secondary" onClick={() => setSummary(null)}>
              Close summary
            </button>
            <h2>Order {summary.id}</h2>
            <p>
              {summary.user__firstname} · {summary.order_statuses}
            </p>
            <dl>
              {Object.entries(summary)
                .filter(([key]) => !['rowKey', 'actionStoreId'].includes(key))
                .map(([key, value]) => (
                  <div className="receipt-line" key={key}>
                    <dt>{key.replaceAll('_', ' ')}</dt>
                    <dd>{String(value ?? '')}</dd>
                  </div>
                ))}
            </dl>
            {appliedType === 'ST' && (
              <button
                className="button primary"
                onClick={() => {
                  onOpen(summary, { crossAccess: selection.body.orderIds.length > 0 });
                  setSummary(null);
                }}
              >
                Open order details
              </button>
            )}
            {appliedType !== 'ST' && (
              <NavLink className="button primary" to={detailLink(summary)}>
                Open order details
              </NavLink>
            )}
            {appliedType === 'HL' && (
              <NavLink className="button secondary" to="/local-deliveries">
                Open local deliveries
              </NavLink>
            )}
            {appliedType === 'HE' && (
              <NavLink className="button secondary" to="/fulfillment">
                Open Express fulfillment
              </NavLink>
            )}
            {summary.actionStoreId && (
              <OrderInvoiceActions
                user={user}
                storeId={summary.actionStoreId}
                orderId={summary.id}
                online={online}
              />
            )}
          </section>
        </div>
      )}
    </section>
  );
}
