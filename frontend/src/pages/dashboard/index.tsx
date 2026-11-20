import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { ErrorState, Loading, Metric, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import './styles.css';
const count = z.string().regex(/^\d+$/),
  store = z.object({ id: z.string(), name: z.string().nullable() });
const overviewSchema = z.object({
  reader: z.literal('primary'),
  asOf: z.string(),
  businessDate: z.string(),
  year: z.number().int(),
  activeStores: count,
  activeOperators: count,
  parentProducts: count,
  stores: z.array(store),
});
const todaySchema = z.object({
  reader: z.literal('data'),
  asOf: z.string(),
  businessDate: z.string(),
  orderAssociations: count,
});
const historySchema = z.object({
  reader: z.literal('bigquery'),
  asOf: z.string(),
  generationId: z.uuid(),
  contract: z.literal('pos-dashboard-orders-v1'),
  year: z.number().int(),
  orderAssociations: count,
  months: z.array(z.string()).length(12),
  series: z.array(store.extend({ counts: z.array(count).length(12) })),
});
const integer = new Intl.NumberFormat('en-IN'),
  formatted = (value: string) => integer.format(BigInt(value));
type History = z.infer<typeof historySchema>;
function MonthlyChart({ history }: { history: History }) {
  const [selected, setSelected] = useState(''),
    visible = history.series.filter((item) => !selected || item.id === selected),
    maximum = visible.reduce(
      (top, item) =>
        item.counts.reduce((max, value) => (BigInt(value) > max ? BigInt(value) : max), top),
      1n,
    );
  const y = (value: string) => 215 - (Number((BigInt(value) * 10000n) / maximum) / 10000) * 180;
  return (
    <>
      <label className="dashboard-series-filter">
        Graph stores
        <select
          aria-label="Graph stores"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">All active stores in scope</option>
          {history.series.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name ?? 'Unnamed store'}
            </option>
          ))}
        </select>
      </label>
      <svg
        className="dashboard-monthly-chart"
        viewBox="0 0 800 260"
        role="img"
        aria-label={`Monthly order counts from ${history.year}, including future-year source data`}
      >
        <title>Monthly order counts</title>
        <line x1="45" x2="780" y1="215" y2="215" style={{ stroke: 'var(--gray-300)' }} />
        <line x1="45" x2="45" y1="30" y2="215" style={{ stroke: 'var(--gray-300)' }} />
        {history.months.map((month, index) => (
          <text
            key={month}
            x={55 + index * 65}
            y="242"
            fontSize="12"
            textAnchor="middle"
            style={{ fill: 'var(--gray-600)' }}
          >
            {month}
          </text>
        ))}
        <text x="40" y="24" textAnchor="start" fontSize="11" style={{ fill: 'var(--gray-600)' }}>
          {formatted(maximum.toString())}
        </text>
        {visible.map((item, index) => (
          <polyline
            key={item.id}
            fill="none"
            style={{ stroke: seriesColours[index % seriesColours.length] }}
            strokeWidth="2"
            points={item.counts.map((value, month) => `${55 + month * 65},${y(value)}`).join(' ')}
          >
            <title>{item.name ?? 'Unnamed store'}</title>
          </polyline>
        ))}
      </svg>
      <div className="dashboard-history-table">
        <table>
          <caption>Exact monthly order counts</caption>
          <thead>
            <tr>
              <th>Store</th>
              {history.months.map((month) => (
                <th key={month}>{month}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id}>
                <th>{item.name ?? 'Unnamed store'}</th>
                {item.counts.map((value, index) => (
                  <td key={index}>{formatted(value)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
/** Chart series in brand order: primary red, then teal, purple and gold from the secondary theme. */
const seriesColours = ['var(--tss-red)', 'var(--teal)', 'var(--purple)', 'var(--gold-ink)'];

export function DashboardPage({ user }: { user: Principal }) {
  const online = useOnline(),
    scope = useMemo(
      () => [user.id, user.role, user.userType, [...user.storeIds].sort().join(',')],
      [user],
    ),
    enabled = online && user.userType === 1;
  const overview = useQuery({
      queryKey: [...scope, 'dashboard-overview'],
      queryFn: ({ signal }) =>
        request('/api/v1/dashboard/overview', { operatorId: user.id, signal }, overviewSchema),
      enabled,
      retry: false,
    }),
    today = useQuery({
      queryKey: [...scope, 'dashboard-today'],
      queryFn: ({ signal }) =>
        request('/api/v1/dashboard/orders/today', { operatorId: user.id, signal }, todaySchema),
      enabled,
      retry: false,
    }),
    history = useQuery({
      queryKey: [...scope, 'dashboard-history'],
      queryFn: ({ signal }) =>
        request(
          '/api/v1/dashboard/orders/history',
          { operatorId: user.id, signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) },
          historySchema,
        ),
      enabled,
      retry: false,
    });
  if (user.userType !== 1)
    return <p role="alert">This dashboard is available to internal operators.</p>;
  return (
    <>
      <PageTitle title="Dashboard">
        <button
          className="button secondary"
          disabled={!online || overview.isFetching || today.isFetching || history.isFetching}
          onClick={() => {
            void overview.refetch();
            void today.refetch();
            void history.refetch();
          }}
        >
          <RefreshCw size={16} />
          Refresh dashboard
        </button>
      </PageTitle>
      {!online && <p role="status">Connect to refresh dashboard figures.</p>}
      {overview.isPending && online ? (
        <Loading />
      ) : overview.isError ? (
        <ErrorState error={overview.error} />
      ) : (
        overview.data && (
          <div className="dashboard-metrics">
            <Metric label="Active stores" value={formatted(overview.data.activeStores)} />
            <Metric label="Active operators" value={formatted(overview.data.activeOperators)} />
            <Metric label="Parent products" value={formatted(overview.data.parentProducts)} />
            <Metric
              label="Total order associations"
              value={history.data ? formatted(history.data.orderAssociations) : '—'}
            />
            <Metric
              label="Today’s order associations"
              value={today.data ? formatted(today.data.orderAssociations) : '—'}
            />
          </div>
        )
      )}
      {today.isError && <ErrorState error={today.error} retry={() => void today.refetch()} />}
      <section className="surface dashboard-history">
        <h2>Monthly orders by store</h2>
        <p className="muted">
          Counts follow order-to-store associations, including source future-year entries. They are
          not revenue or unique-customer totals.
        </p>
        {history.isPending && online ? (
          <Loading />
        ) : history.isError ? (
          <ErrorState error={history.error} retry={() => void history.refetch()} />
        ) : (
          history.data && (
            <>
              <p className="muted">
                Warehouse publication as of{' '}
                <time dateTime={history.data.asOf}>
                  {new Date(history.data.asOf).toLocaleString()}
                </time>
                .
              </p>
              {history.data.series.length ? (
                <MonthlyChart key={history.data.generationId} history={history.data} />
              ) : (
                <p>No active stores are available in your scope.</p>
              )}
            </>
          )
        )}
      </section>
    </>
  );
}
export default DashboardPage;
