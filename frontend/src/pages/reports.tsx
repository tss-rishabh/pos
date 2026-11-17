import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowRight } from 'lucide-react';
import { z } from 'zod';
import { captureOperatorScope, request, params } from '../api/client';
import type { Principal } from '../api/types';
import { Empty, ErrorState, Loading, Metric, PageTitle } from '../components/common';
import { currency } from '../lib/format';
import { useOnline, useStores } from '../hooks/use-pos';
import { ReportNavigation } from '../components/report-navigation';

const metric = z.union([z.string(), z.number().finite(), z.null()]);
const responseSchema = z.object({
  reader: z.enum(['primary', 'data', 'bigquery']),
  range: z.object({ start: z.string(), end: z.string() }),
  data: z.array(z.record(z.string(), metric)),
  totals: z.record(z.string(), metric),
  pendingOrderCount: z.number().int().nonnegative().safe().default(0),
  publication: z
    .object({
      generationId: z.string(),
      publishedAt: z.iso.datetime(),
      cdcWatermark: z.iso.datetime(),
    })
    .optional(),
});
export const dailyReportFields = [
  ['store_name', 'Store'],
  ['date', 'Date'],
  ['target', 'Target'],
  ['store_revenue', 'Store revenue'],
  ['online_revenue', 'Online revenue'],
  ['total_revenue', 'Total revenue'],
  ['target_achieved_pct', 'Target achieved %'],
  ['store_orders', 'Store orders'],
  ['online_orders', 'Online orders'],
  ['total_orders', 'Orders'],
  ['aov', 'AOV'],
  ['online_qty', 'Online quantity'],
  ['store_qty', 'Store quantity'],
  ['total_qty', 'Units'],
  ['basket_size', 'Basket size'],
  ['footfall', 'Footfall'],
  ['conversion_pct', 'Conversion %'],
  ['membership_purchase_orders', 'New membership orders'],
  ['membership_orders_total', 'Membership orders (old + new)'],
  ['membership_conversion_pct', 'Member conversion %'],
  ['membership_aov', 'Member AOV'],
  ['tss_money_used', 'TSS money used'],
  ['tss_points_used', 'TSS points used'],
  ['revenue_per_footfall', 'Revenue per footfall'],
  ['pg_discount', 'PG discount'],
  ['gift_voucher', 'Gift voucher'],
  ['district', 'District'],
  ['cash', 'Cash'],
  ['payment_correction_cash_out', 'Cash returned on corrections'],
  ['cash_after_payment_corrections', 'Cash after corrections'],
  ['total_online', 'Card / UPI'],
  ['banking', 'Banking'],
  ['membership_revenue', 'Membership revenue'],
  ['pending_offline_orders', 'Offline orders awaiting import'],
] as const;
type Field = (typeof dailyReportFields)[number][0];
interface Filters {
  from: string;
  to: string;
  storeIds: string[];
}
const pageSize = 50;
const defaultColumns: Field[] = [
  'store_name',
  'date',
  'target',
  'total_revenue',
  'target_achieved_pct',
  'total_orders',
  'aov',
  'total_qty',
  'basket_size',
  'footfall',
  'conversion_pct',
  'membership_conversion_pct',
  'cash',
  'payment_correction_cash_out',
  'cash_after_payment_corrections',
  'total_online',
  'district',
  'banking',
];
function savedColumns(userId: string): Field[] {
  try {
    const values = z
        .array(z.string())
        .parse(
          JSON.parse(
            localStorage.getItem(`pos-daily-report-columns:${userId}`) || 'null',
          ) as unknown,
        ),
      keys = new Set<string>(dailyReportFields.map(([key]) => key)),
      selected = values.filter((key): key is Field => keys.has(key));
    return selected.length ? [...new Set(selected)] : defaultColumns;
  } catch {
    return defaultColumns;
  }
}
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe =
    typeof value === 'string' &&
    !/^[-+]?\d+(?:\.\d+)?$/.test(text) &&
    /^[\p{C}\p{Z}\s]*[=+\-@\t\r]/u.test(text)
      ? "'" + text
      : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}
export function ReportsPage({ user, storeId }: { user: Principal; storeId: string }) {
  const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }),
    today = format.format(new Date()),
    online = useOnline(),
    stores = useStores(user.id);
  const [from, setFrom] = useState(format.format(new Date(Date.now() - 4 * 86400000))),
    [to, setTo] = useState(today),
    [storeIds, setStoreIds] = useState<string[]>(storeId ? [storeId] : []),
    [submitted, setSubmitted] = useState<Filters | null>(null),
    [columns, setColumns] = useState<Field[]>(() => savedColumns(user.id)),
    [page, setPage] = useState(1);
  const fields = dailyReportFields.filter(([key]) => columns.includes(key));
  const report = useQuery({
    queryKey: [user.id, 'daily-report', submitted],
    enabled: !!submitted && online,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/reports/daily-store-sales?${params({ storeIds: submitted!.storeIds.join(','), from: submitted!.from, to: submitted!.to })}`,
        { operatorId: user.id, signal },
        responseSchema,
      ),
    retry: false,
  });
  const totalPages = Math.max(1, Math.ceil((report.data?.data.length || 0) / pageSize)),
    currentPage = Math.min(page, totalPages);
  function changeColumns(next: Field[]) {
    setColumns(next);
    try {
      localStorage.setItem(`pos-daily-report-columns:${user.id}`, JSON.stringify(next));
    } catch {
      /* Preferences are optional. */
    }
  }
  function download() {
    if (!report.data) return;
    let signal: AbortSignal;
    try {
      signal = captureOperatorScope(user.id);
    } catch {
      return;
    }
    const rows = [
      dailyReportFields.map(([, label]) => label),
      ...[...report.data.data, report.data.totals].map((row) =>
        dailyReportFields.map(([key]) => row[key]),
      ),
    ];
    const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const link = document.createElement('a'),
      url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.href = url;
    link.download = `daily-store-sales-${submitted?.from}-${submitted?.to}.csv`;
    signal.throwIfAborted();
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <PageTitle eyebrow="A CLEARER PICTURE OF THE DAY" title="Daily store sales">
        <button
          className="button secondary"
          onClick={download}
          disabled={!report.data || report.isFetching}
        >
          <ArrowDownToLine size={16} />
          Export CSV
        </button>
      </PageTitle>
      <ReportNavigation user={user} />
      {!online && (
        <p role="status">Reconnect to run a report. The last open result remains visible.</p>
      )}
      {stores.isError && <ErrorState error={stores.error} retry={() => void stores.refetch()} />}
      <section className="surface">
        <form
          className="daily-report-filters"
          onSubmit={(event) => {
            event.preventDefault();
            if (!online || !storeIds.length) return;
            const next = { from, to, storeIds: [...new Set(storeIds)].sort() };
            setPage(1);
            if (JSON.stringify(next) === JSON.stringify(submitted)) void report.refetch();
            else setSubmitted(next);
          }}
        >
          <label>
            Stores
            <select
              aria-label="Report stores"
              multiple
              required
              value={storeIds}
              onChange={(event) =>
                setStoreIds(Array.from(event.target.selectedOptions, (option) => option.value))
              }
            >
              {(stores.data || []).map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            From{' '}
            <input
              aria-label="Report from date"
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            To{' '}
            <input
              aria-label="Report to date"
              type="date"
              required
              min={from}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={!storeIds.length || !online || report.isFetching}
          >
            View report
            <ArrowRight size={16} />
          </button>
        </form>
        <details className="daily-report-columns">
          <summary>
            Columns ({columns.length} of {dailyReportFields.length})
          </summary>
          <div className="daily-report-pagination">
            <button
              className="button secondary"
              onClick={() => changeColumns(dailyReportFields.map(([key]) => key))}
            >
              Show all columns
            </button>
            <button className="button secondary" onClick={() => changeColumns(defaultColumns)}>
              Reset columns
            </button>
          </div>
          <fieldset>
            <legend className="sr-only">Visible daily report columns</legend>
            {dailyReportFields.map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={columns.includes(key)}
                  disabled={columns.length === 1 && columns.includes(key)}
                  onChange={() => {
                    const next = columns.includes(key)
                      ? columns.filter((value) => value !== key)
                      : [...columns, key];
                    changeColumns(next);
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <p className="muted">
            CSV exports contain every column, every result row and the full totals.
          </p>
        </details>
      </section>
      {!submitted ? (
        <Empty title="The day, by the numbers">
          Select a date range to view store and store-assisted online sales.
        </Empty>
      ) : report.isPending ? (
        <Loading />
      ) : report.isError ? (
        <ErrorState error={report.error} retry={() => void report.refetch()} />
      ) : (
        <>
          {report.data.pendingOrderCount > 0 && (
            <p role="status">
              {report.data.pendingOrderCount} offline cash{' '}
              {report.data.pendingOrderCount === 1 ? 'receipt is' : 'receipts are'} awaiting order
              import. Cash and order counts include these receipts. Quantities and revenue reflect
              imported sales.
            </p>
          )}
          {report.data.publication && (
            <p className="muted">
              Data updated through {new Date(report.data.publication.cdcWatermark).toLocaleString()}
              .
            </p>
          )}
          <div className="metrics report-metrics">
            <Metric
              label="Revenue"
              value={currency(Number(report.data.totals.total_revenue || 0))}
              note="Store + store-assisted online"
            />
            <Metric label="Orders" value={String(report.data.totals.total_orders || 0)} />
            <Metric
              label="Average order value"
              value={currency(Number(report.data.totals.aov || 0))}
            />
            <Metric label="Units per order" value={String(report.data.totals.basket_size || 0)} />
          </div>
          <section className="surface">
            <div className="surface-title">
              <h2>Daily breakdown</h2>
              <span className="muted">{report.data.data.length} rows</span>
            </div>
            <div className="table-wrap">
              <table className="daily-report-table" aria-label="Daily store sales breakdown">
                <thead>
                  <tr>
                    {fields.map(([key, label]) => (
                      <th key={key}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.data.data
                    .slice((currentPage - 1) * pageSize, currentPage * pageSize)
                    .map((row, i) => (
                      <tr key={i}>
                        {fields.map(([key]) => (
                          <td key={key}>
                            {row[key] === null || row[key] === undefined ? '—' : String(row[key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
                <tfoot>
                  <tr>
                    {fields.map(([key]) => (
                      <td key={key}>
                        {report.data.totals[key] === null || report.data.totals[key] === undefined
                          ? '—'
                          : String(report.data.totals[key])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="daily-report-pagination">
              <span>
                Page {currentPage} of {totalPages} · totals cover all {report.data.data.length} rows
              </span>
              <div>
                <button
                  className="button secondary"
                  disabled={currentPage === 1}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous page
                </button>
                <button
                  className="button secondary"
                  disabled={currentPage === totalPages}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next page
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </>
  );
}
