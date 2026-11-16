import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { ErrorState, Loading } from '../../components/common';
import type { ProfileScope } from './client';
import { readCustomerHistory, readCustomerOrderLines, type HistoryCursor } from './history-client';
import './style.css';

interface HistoryProps {
  scope: ProfileScope;
  checkoutVersion: number;
  online: boolean;
  disabled?: boolean;
  orderDetailsPath?: (orderId: string) => string;
  feedbackPath?: (orderId: string) => string;
}
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const formatCount = (value: string) => BigInt(value).toLocaleString('en-IN');

/** Reset every page/selection when the owning sale or version changes. */
export function CustomerHistoryCard(props: HistoryProps) {
  const { scope, checkoutVersion } = props;
  return (
    <ScopedHistory
      key={[
        scope.operatorId,
        scope.storeId,
        scope.checkoutId,
        scope.customerId,
        checkoutVersion,
      ].join(':')}
      {...props}
    />
  );
}
function OrderItems({
  scope,
  checkoutVersion,
  online,
  disabled,
  orderId,
  close,
}: HistoryProps & { orderId: string; close: () => void }) {
  const [cursors, setCursors] = useState<readonly HistoryCursor[]>([]);
  const before = cursors.at(-1);
  const lines = useQuery({
    queryKey: [
      scope.operatorId,
      'checkout-customer-order-lines',
      scope.storeId,
      scope.checkoutId,
      scope.customerId,
      checkoutVersion,
      orderId,
      before,
    ],
    enabled: online && !disabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) =>
      readCustomerOrderLines(scope, checkoutVersion, orderId, before, signal),
  });
  return (
    <section className="customer-history-items" aria-label={`Items for order ${orderId}`}>
      <div className="toolbar">
        <h4>Items for order {orderId}</h4>
        <button type="button" className="button secondary" onClick={close}>
          Close items
        </button>
      </div>
      {lines.isPending || lines.isFetching ? (
        <Loading />
      ) : lines.isError ? (
        <ErrorState error={lines.error} retry={() => void lines.refetch()} />
      ) : (
        <>
          {lines.data?.items.length ? (
            <ul>
              {lines.data.items.map((line) => (
                <li key={line.id}>{line.name}</li>
              ))}
            </ul>
          ) : (
            <p>No items were recorded.</p>
          )}
          <div className="toolbar">
            <button
              type="button"
              className="button secondary"
              disabled={!cursors.length}
              onClick={() => setCursors(cursors.slice(0, -1))}
            >
              Previous items
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!lines.data?.nextCursor}
              onClick={() => {
                const anchor = lines.data?.items.at(-1);
                if (lines.data?.nextCursor && anchor)
                  setCursors([...cursors, { token: lines.data.nextCursor, anchorId: anchor.id }]);
              }}
            >
              More items
            </button>
          </div>
        </>
      )}
    </section>
  );
}
function ScopedHistory(props: HistoryProps) {
  const {
    scope,
    checkoutVersion,
    online,
    disabled = false,
    orderDetailsPath,
    feedbackPath,
  } = props;
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<readonly HistoryCursor[]>([]);
  const [orderId, setOrderId] = useState<string | null>(null);
  const before = cursors.at(-1);
  const history = useQuery({
    queryKey: [
      scope.operatorId,
      'checkout-customer-history',
      scope.storeId,
      scope.checkoutId,
      scope.customerId,
      checkoutVersion,
      before,
    ],
    enabled: open && online && !disabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => readCustomerHistory(scope, checkoutVersion, before, signal),
  });
  const value = history.data;
  return (
    <section aria-label="Customer history">
      <button
        type="button"
        className="button secondary"
        disabled={!online || disabled}
        aria-expanded={open && online && !disabled}
        onClick={() => setOpen(!open)}
      >
        <History size={15} />
        {open ? 'Hide customer history' : 'Customer history'}
      </button>
      {open && online && !disabled && (
        <div className="customer-profile-panel customer-history-panel">
          <p className="caption">Historical figures may take time to reflect recent sales.</p>
          {history.isPending || history.isFetching ? (
            <Loading />
          ) : history.isError ? (
            <ErrorState error={history.error} retry={() => void history.refetch()} />
          ) : (
            value && (
              <>
                <dl>
                  <dt>Lifetime exclusive savings</dt>
                  <dd>{currency.format(value.summary.exclusiveSavings)}</dd>
                  <dt>Total orders</dt>
                  <dd>{formatCount(value.summary.totalOrders)}</dd>
                  <dt>Store orders</dt>
                  <dd>{formatCount(value.summary.totalStoreOrders)}</dd>
                  <dt>Online orders</dt>
                  <dd>{formatCount(value.summary.totalOnlineOrders)}</dd>
                  <dt>Orders in last 30 days</dt>
                  <dd>{formatCount(value.summary.last30DaysOrders)}</dd>
                  <dt>Cancelled orders</dt>
                  <dd>{formatCount(value.summary.cancelledOrders)}</dd>
                  <dt>Returned orders</dt>
                  <dd>{formatCount(value.summary.returnedOrders)}</dd>
                  <dt>Average NPS score</dt>
                  <dd>
                    {value.summary.npsScore === null
                      ? 'No feedback'
                      : String(value.summary.npsScore)}
                  </dd>
                </dl>
                <h4>Recent orders</h4>
                {value.recentOrders.length ? (
                  <div className="customer-history-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Order</th>
                          <th>Date</th>
                          <th>Amount</th>
                          <th>Channel</th>
                          <th>Feedback</th>
                        </tr>
                      </thead>
                      <tbody>
                        {value.recentOrders.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <button
                                type="button"
                                className="button secondary"
                                aria-label={`View items for order ${row.id}`}
                                onClick={() => setOrderId(row.id)}
                              >
                                {row.id}
                              </button>
                              {orderDetailsPath && (
                                <a href={orderDetailsPath(row.id)}>Open order</a>
                              )}
                            </td>
                            <td>{row.createdDate || '—'}</td>
                            <td>{currency.format(row.orderAmount)}</td>
                            <td>{row.isStoreOrder ? 'Store' : 'Online'}</td>
                            <td>
                              {row.status === 3 && feedbackPath ? (
                                <a href={feedbackPath(row.id)}>View feedback</a>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>No recent orders.</p>
                )}
                <h4>Returned orders</h4>
                {value.returnedOrders.items.length ? (
                  <div className="customer-history-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Order</th>
                          <th>Amount</th>
                          <th>Items</th>
                        </tr>
                      </thead>
                      <tbody>
                        {value.returnedOrders.items.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <button
                                type="button"
                                className="button secondary"
                                aria-label={`View returned order ${row.id}`}
                                onClick={() => setOrderId(row.id)}
                              >
                                {row.id}
                              </button>
                              {orderDetailsPath && (
                                <a href={orderDetailsPath(row.id)}>Open order</a>
                              )}
                            </td>
                            <td>{currency.format(row.orderAmount)}</td>
                            <td>
                              {row.itemNames.join(', ') || '—'}
                              {row.hasMoreItems && (
                                <button
                                  type="button"
                                  className="button secondary"
                                  aria-label={`View all items for returned order ${row.id}`}
                                  onClick={() => setOrderId(row.id)}
                                >
                                  View all {formatCount(row.itemCount)} items
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>No returned orders on this page.</p>
                )}
                <div className="toolbar">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!cursors.length}
                    onClick={() => {
                      setOrderId(null);
                      setCursors(cursors.slice(0, -1));
                    }}
                  >
                    Previous returns
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!value.returnedOrders.nextCursor}
                    onClick={() => {
                      if (value.returnedOrders.nextCursor) {
                        setOrderId(null);
                        const anchor = value.returnedOrders.items.at(-1);
                        if (anchor)
                          setCursors([
                            ...cursors,
                            { token: value.returnedOrders.nextCursor, anchorId: anchor.id },
                          ]);
                      }
                    }}
                  >
                    More returned orders
                  </button>
                </div>
              </>
            )
          )}
          {orderId && (
            <OrderItems key={orderId} {...props} orderId={orderId} close={() => setOrderId(null)} />
          )}
        </div>
      )}
    </section>
  );
}
