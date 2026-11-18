import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, Search, Columns3 } from 'lucide-react';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { queueReportExport } from './export-commands';
import { orderReportColumns } from './order-report-columns';
import './style.css';
type Field = (typeof orderReportColumns)[number][1];
const scalar = z.union([z.string(), z.number().finite(), z.null()]),
  rowSchema = z.record(z.string(), scalar).superRefine((row, ctx) => {
    if (typeof row.id !== 'string')
      ctx.addIssue({ code: 'custom', message: 'A report record identity is missing.' });
    for (const [, field] of orderReportColumns)
      if (!(field in row))
        ctx.addIssue({ code: 'custom', message: 'A report column is missing.', path: [field] });
  }),
  resultSchema = z.object({
    reader: z.enum(['data', 'bigquery']),
    data: z.array(rowSchema),
    total: z.number(),
    page: z.number(),
    totalPages: z.number(),
  });
interface Filters {
  from: string;
  to: string;
  storeIds: string[];
  source: 'store' | 'online';
  dateType: 'order_date' | 'return_date';
}
const defaultColumns: Field[] = [
  'order_id',
  'transaction_status',
  'date',
  'store_name',
  'counter_name',
  'payment_mode',
  'pay_amount',
  'line_item_qty',
  'variant_product',
  'taxable_value_minus_pg',
  'gst',
  'total_sale',
  'pay_amount_refunded',
  'invoice_no',
  'credit_note_no',
];
function initial(storeId: string): Filters {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return {
    from: today + 'T00:00:00',
    to: today + 'T23:59:59',
    storeIds: storeId ? [storeId] : [],
    source: 'store',
    dateType: 'order_date',
  };
}
function savedColumns(userId: string): Field[] {
  try {
    const values = z
        .array(z.string())
        .parse(
          JSON.parse(
            localStorage.getItem(`pos-order-report-columns:${userId}`) || 'null',
          ) as unknown,
        ),
      known = new Set<string>(orderReportColumns.map(([, field]) => field)),
      selected = values.filter((field): field is Field => known.has(field));
    return selected.length ? [...new Set(selected)] : defaultColumns;
  } catch {
    return defaultColumns;
  }
}
export function OrderTransactionsPage({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    queryClient = useQueryClient(),
    [filters, setFilters] = useState(() => initial(storeId)),
    [submitted, setSubmitted] = useState(() => initial(storeId)),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25),
    [selected, setSelected] = useState(() => savedColumns(user.id));
  useEffect(() => {
    try {
      localStorage.setItem(`pos-order-report-columns:${user.id}`, JSON.stringify(selected));
    } catch {
      /* Preferences are optional when local storage is unavailable. */
    }
  }, [selected, user.id]);
  const stores = useQuery({
      queryKey: [user.id, 'finance-cash-ledger-stores'],
      queryFn: () =>
        request(
          '/api/v1/reports/store-cash-balances/stores',
          {},
          z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }),
        ),
    }),
    report = useQuery({
      queryKey: [user.id, 'order-transactions-report', submitted, page, pageSize],
      queryFn: () =>
        request(
          '/api/v1/reports/order-transactions/search',
          { method: 'POST', body: JSON.stringify({ ...submitted, page, pageSize }) },
          resultSchema,
        ),
      retry: false,
    }),
    createExport = useMutation({
      mutationFn: (columns: readonly Field[] | null) =>
        queueReportExport(user.id, {
          kind: 'order-transactions',
          ...submitted,
          attempts: 'all',
          search: '',
          ...(columns ? { columns, sort: 'transaction_date', direction: 'desc' as const } : {}),
        }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: [user.id, 'report-exports'] }),
    });
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) =>
      setFilters((current) => ({ ...current, [key]: value })),
    visible = orderReportColumns.filter(([, field]) => selected.includes(field));
  return (
    <>
      <PageTitle eyebrow="EVERY LINE, ACCOUNTED FOR" title="Order transactions">
        <button
          className="button secondary"
          disabled={!online || !report.data?.total || createExport.isPending}
          onClick={() => createExport.mutate(null)}
        >
          <ArrowDownToLine size={16} />
          {createExport.isPending ? 'Requesting…' : 'Export complete CSV'}
        </button>
        <button
          className="button secondary"
          disabled={!online || !report.data?.total || !visible.length || createExport.isPending}
          onClick={() => createExport.mutate(visible.map(([, field]) => field))}
        >
          <ArrowDownToLine size={16} />
          {createExport.isPending ? 'Requesting…' : 'Export visible columns CSV'}
        </button>
      </PageTitle>
      <form
        className="surface resource-report-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(filters);
          setPage(1);
        }}
      >
        <label>
          From
          <input
            type="datetime-local"
            step="1"
            required
            value={filters.from}
            onChange={(event) => update('from', event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            step="1"
            required
            value={filters.to}
            min={filters.from}
            onChange={(event) => update('to', event.target.value)}
          />
        </label>
        <label>
          Stores
          <select
            multiple
            value={filters.storeIds}
            onChange={(event) =>
              update(
                'storeIds',
                Array.from(event.target.selectedOptions, (option) => option.value),
              )
            }
          >
            {stores.data?.data
              .filter((store) => user.userType !== 2 || user.storeIds.includes(store.id))
              .map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
          </select>
          <small>Choose the stores to include.</small>
        </label>
        <label>
          Order source
          <select
            value={filters.source}
            onChange={(event) =>
              update('source', event.target.value === 'online' ? 'online' : 'store')
            }
          >
            <option value="store">Store orders</option>
            <option value="online">Online orders</option>
          </select>
        </label>
        <label>
          Date basis
          <select
            value={filters.dateType}
            onChange={(event) =>
              update(
                'dateType',
                event.target.value === 'return_date' ? 'return_date' : 'order_date',
              )
            }
          >
            <option value="order_date">Order date</option>
            <option value="return_date">Return date</option>
          </select>
        </label>
        <button className="button primary" disabled={!online || report.isFetching}>
          <Search size={16} />
          View report
        </button>
      </form>
      <p className="muted">
        Return date changes the return entries. Sales use the store order date or online allocation
        date. Each row represents a line transaction.
      </p>
      {stores.isError && <ErrorState error={stores.error} />}
      {createExport.isError && <ErrorState error={createExport.error} />}
      {createExport.isSuccess && (
        <p className="operational-report-success" role="status">
          Export requested. The complete file will appear in Report exports.
        </p>
      )}
      {!online && <p role="status">Connect to refresh reports or request a file.</p>}
      <details className="surface order-report-columns">
        <summary>
          <Columns3 size={16} />
          {visible.length} of {orderReportColumns.length} columns
        </summary>
        <div className="order-report-column-actions">
          <button className="button secondary" onClick={() => setSelected(defaultColumns)}>
            Core columns
          </button>
          <button
            className="button secondary"
            onClick={() => setSelected(orderReportColumns.map(([, field]) => field))}
          >
            Show all columns
          </button>
        </div>
        <div className="order-report-column-options">
          {orderReportColumns.map(([label, field]) => (
            <label key={field}>
              <input
                type="checkbox"
                checked={selected.includes(field)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, field]
                      : current.filter((value) => value !== field),
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
      </details>
      {report.isPending ? (
        <Loading />
      ) : report.isError ? (
        <ErrorState error={report.error} retry={() => void report.refetch()} />
      ) : !report.data.data.length ? (
        <Empty title="No transactions found">
          Choose stores and a date range to inspect sales and returns.
        </Empty>
      ) : !visible.length ? (
        <Empty title="Choose report columns">
          Select the columns to display or restore core columns.
        </Empty>
      ) : (
        <>
          <p className="muted">{report.data.total.toLocaleString()} line transaction(s)</p>
          <div className="surface resource-report-table">
            <table>
              <thead>
                <tr>
                  {visible.map(([label, field]) => (
                    <th key={field}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.data.data.map((row, index) => (
                  <tr key={`${row.id}:${row.transaction_status}:${index}`}>
                    {visible.map(([, field]) => (
                      <td key={field}>{row[field] === null ? '—' : String(row[field])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="resource-report-pagination">
            <button
              className="button secondary"
              disabled={report.data.page <= 1 || report.isFetching}
              onClick={() => setPage(report.data.page - 1)}
            >
              Previous
            </button>
            <span>
              Page {report.data.page} of {report.data.totalPages}
            </span>
            <label>
              Rows
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {[25, 50, 100, 250, 500].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button secondary"
              disabled={report.data.page >= report.data.totalPages || report.isFetching}
              onClick={() => setPage(report.data.page + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </>
  );
}
