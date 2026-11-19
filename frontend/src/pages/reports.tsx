import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowRight } from 'lucide-react';
import { z } from 'zod';
import { captureOperatorScope, request, params } from '../api/client';
import type { Principal } from '../api/types';
import { Empty, ErrorState, Metric, PageTitle } from '../components/common';
import { SkeletonTable } from '../components/loader';
import { MultiSelect } from '../components/multi-select';
import './order-history/table-tools.css';
import { currency } from '../lib/format';
import { useOnline } from '../hooks/use-pos';
import { dailyReportDates } from './finance/report-dates';
import { ReportNavigation } from '../components/report-navigation';
import { TextCell } from '../components/text-cell';

const metric = z.union([z.string(), z.number().finite(), z.null()]);
const responseSchema = z.object({
  reader: z.enum(['primary', 'data', 'bigquery']),
  range: z.object({ start: z.string(), end: z.string() }),
  data: z.array(z.record(z.string(), metric)),
  totals: z.record(z.string(), metric),
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
] as const;
type Field = (typeof dailyReportFields)[number][0];
interface Filters {
  from: string;
  to: string;
  storeIds: string[];
}
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
  const online = useOnline(),
    stores = useQuery({
      queryKey: [user.id, 'finance-cash-ledger-stores'],
      queryFn: async ({ signal }) =>
        await request(
          '/api/v1/reports/store-cash-balances/stores',
          { operatorId: user.id, signal },
          z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }),
        ),
    });
  const availableStores = (stores.data?.data || []).filter(
    (store) => user.userType !== 2 || user.storeIds.includes(store.id),
  );
  const [defaults] = useState(dailyReportDates);
  const [from, setFrom] = useState(defaults.from),
    [to, setTo] = useState(defaults.to),
    [storeIds, setStoreIds] = useState<string[]>(storeId ? [storeId] : []),
    [submitted, setSubmitted] = useState<Filters | null>(null),
    [columns, setColumns] = useState<Field[]>(() => savedColumns(user.id)),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(50),
    [tableSearch, setTableSearch] = useState(''),
    [sort, setSort] = useState<Field>('date'),
    [direction, setDirection] = useState<'asc' | 'desc'>('desc');
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
  const matchingRows = useMemo(() => {
    const terms = [...tableSearch.matchAll(/"([^"]+)"|(\S+)/g)].map((match) =>
        (match[1] ?? match[2] ?? '').toLocaleLowerCase(),
      ),
      collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    return (report.data?.data ?? [])
      .filter((row) => {
        if (!terms.length) return true;
        const text = dailyReportFields
          .map(([key]) => String(row[key] ?? ''))
          .join(' ')
          .toLocaleLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const a = left.row[sort],
          b = right.row[sort];
        let compared: number;
        if (a === null || a === undefined || a === '')
          compared = b === null || b === undefined || b === '' ? 0 : -1;
        else if (b === null || b === undefined || b === '') compared = 1;
        else if (
          sort !== 'date' &&
          sort !== 'store_name' &&
          Number.isFinite(Number(a)) &&
          Number.isFinite(Number(b))
        )
          compared = Number(a) - Number(b);
        else compared = collator.compare(String(a), String(b));
        return (direction === 'asc' ? compared : -compared) || left.index - right.index;
      })
      .map(({ row }) => row);
  }, [report.data?.data, tableSearch, sort, direction]);
  const totalPages = Math.max(1, Math.ceil(matchingRows.length / pageSize)),
    currentPage = Math.min(page, totalPages);
  function changeColumns(next: Field[]) {
    setColumns(next);
    try {
      localStorage.setItem(`pos-daily-report-columns:${user.id}`, JSON.stringify(next));
    } catch {
      /* Preferences are optional. */
    }
  }
  function download(visibleOnly = false) {
    if (!report.data) return;
    let signal: AbortSignal;
    try {
      signal = captureOperatorScope(user.id);
    } catch {
      return;
    }
    const selected = visibleOnly ? fields : dailyReportFields;
    const rows = [
      selected.map(([, label]) => label),
      ...[...(visibleOnly ? matchingRows : report.data.data), report.data.totals].map((row) =>
        selected.map(([key]) => row[key]),
      ),
    ];
    const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const link = document.createElement('a'),
      url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.href = url;
    link.download = `daily-store-sales-${submitted?.from}-${submitted?.to}${visibleOnly ? '-visible' : ''}.csv`;
    signal.throwIfAborted();
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <PageTitle title="Daily store sales">
        <button
          className="button secondary"
          onClick={() => download()}
          disabled={!report.data || report.isFetching}
        >
          <ArrowDownToLine size={16} />
          Export CSV
        </button>
        <button
          className="button secondary"
          onClick={() => download(true)}
          disabled={!report.data || report.isFetching || !fields.length}
        >
          <ArrowDownToLine size={16} />
          Export visible columns CSV
        </button>
      </PageTitle>
      <ReportNavigation user={user} />
      {!online && (
        <p role="status">Reconnect to run a report. The last open result remains visible.</p>
      )}
      {stores.isError && <ErrorState error={stores.error} retry={() => void stores.refetch()} />}
      <section className="surface daily-report-panel">
        <form
          className="daily-report-filters"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !online ||
              !storeIds.length ||
              stores.isError ||
              stores.isPending ||
              storeIds.some((id) => !availableStores.some((store) => store.id === id))
            )
              return;
            const next = { from, to, storeIds: [...new Set(storeIds)].sort() };
            setPage(1);
            if (JSON.stringify(next) === JSON.stringify(submitted)) void report.refetch();
            else setSubmitted(next);
          }}
        >
          <div className="daily-report-stores">
            <MultiSelect
              label="Stores"
              emptyLabel="Select stores"
              disabled={!availableStores.length}
              options={availableStores.map((store) => ({ value: store.id, label: store.name }))}
              value={storeIds}
              onChange={setStoreIds}
            />
            <div className="toolbar">
              <button
                type="button"
                className="text-button"
                disabled={!availableStores.length}
                onClick={() => setStoreIds(availableStores.map((store) => store.id))}
              >
                Select all stores
              </button>
              <button
                type="button"
                className="text-button"
                disabled={!storeIds.length}
                onClick={() => setStoreIds([])}
              >
                Clear all stores
              </button>
            </div>
          </div>
          <label>
            From
            <input
              aria-label="Report from date"
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            To
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
            disabled={
              !storeIds.length ||
              !online ||
              stores.isError ||
              stores.isPending ||
              report.isFetching ||
              storeIds.some((id) => !availableStores.some((store) => store.id === id))
            }
            aria-busy={report.isFetching}
          >
            View report
            {!report.isFetching && <ArrowRight size={16} aria-hidden="true" />}
          </button>
        </form>
        <details className="column-picker daily-report-columns">
          <summary>
            Columns ({columns.length} of {dailyReportFields.length})
          </summary>
          <div className="column-picker-panel daily-report-column-panel">
            <div className="toolbar">
              <button
                className="button secondary small"
                onClick={() => changeColumns(dailyReportFields.map(([key]) => key))}
              >
                Show all columns
              </button>
              <button
                className="button secondary small"
                onClick={() => changeColumns(defaultColumns)}
              >
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
              The complete CSV contains every column and result row. Visible-column CSV follows the
              table search and sort. Both include the full report totals.
            </p>
          </div>
        </details>
      </section>
      {!submitted ? (
        <Empty title="No report yet">
          Select a date range to view store and store-assisted online sales.
        </Empty>
      ) : report.isPending ? (
        <SkeletonTable rows={6} columns={Math.min(8, fields.length || 1)} label="Loading report…" />
      ) : report.isError ? (
        <ErrorState error={report.error} retry={() => void report.refetch()} />
      ) : (
        <>
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
            <div className="daily-report-filters">
              <label>
                Search report
                <input
                  maxLength={150}
                  value={tableSearch}
                  onChange={(event) => {
                    setTableSearch(event.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <label>
                Sort report
                <select
                  aria-label="Sort report"
                  value={sort}
                  onChange={(event) => {
                    const selected = dailyReportFields.find(([key]) => key === event.target.value);
                    if (selected) setSort(selected[0]);
                    setPage(1);
                  }}
                >
                  {dailyReportFields.map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Sort direction
                <select
                  aria-label="Sort direction"
                  value={direction}
                  onChange={(event) => {
                    setDirection(event.target.value === 'asc' ? 'asc' : 'desc');
                    setPage(1);
                  }}
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </label>
              <label>
                Rows
                <select
                  aria-label="Rows"
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setPage(1);
                  }}
                >
                  {[10, 25, 50, 100, 500].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
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
                  {matchingRows
                    .slice((currentPage - 1) * pageSize, currentPage * pageSize)
                    .map((row, i) => (
                      <tr key={i}>
                        {fields.map(([key]) => (
                          <TextCell key={key} value={row[key]} />
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
                Page {currentPage} of {totalPages} · {matchingRows.length} matching rows · totals
                cover all {report.data.data.length} rows
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
