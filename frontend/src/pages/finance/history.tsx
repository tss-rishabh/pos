import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, Search } from 'lucide-react';
import { z } from 'zod';
import { params, request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { downloadReportCsv } from './download';
import './style.css';
const fields = [
  ['store_name', 'Store'],
  ['close_date', 'Date'],
  ['version', 'Attempt'],
  ['status', 'Status'],
  ['stale_reason', 'Invalidated by'],
  ['cash_system', 'Cash (system)'],
  ['cash_refund_system', 'Cash refund'],
  ['cash_actual', 'Cash (actual)'],
  ['cash_manual_punched', 'Cash manual punched'],
  ['cash_manual_created', 'Cash manual created'],
  ['cash_difference', 'Cash difference'],
  ['cash_result', 'Cash result'],
  ['cash_reason', 'Cash reason'],
  ['cash_comment', 'Cash comment'],
  ['card_system', 'Online (system)'],
  ['card_actual', 'Online (actual)'],
  ['card_manual_punched', 'Online manual punched'],
  ['card_manual_created', 'Online manual created'],
  ['card_difference', 'Online difference'],
  ['card_result', 'Online result'],
  ['card_reason', 'Online reason'],
  ['card_comment', 'Online comment'],
  ['district_system', 'District'],
  ['banking_amount', 'Banking'],
  ['closed_by', 'Closed by'],
  ['closed_at', 'Closed at'],
  ['closed_late', 'Closed late'],
  ['last_verified_at', 'Last verified'],
] as const;
const rowSchema = z.object({
  id: z.string(),
  store_id: z.string(),
  store_name: z.string(),
  close_date: z.string(),
  version: z.number(),
  status: z.string(),
  stale_reason: z.string().nullable(),
  cash_system: z.string(),
  cash_refund_system: z.string(),
  cash_actual: z.string(),
  cash_manual_punched: z.string(),
  cash_manual_created: z.string(),
  cash_difference: z.string(),
  cash_result: z.enum(['TALLIED', 'SHORT', 'EXCESS']),
  cash_reason: z.string(),
  cash_comment: z.string(),
  card_system: z.string(),
  card_actual: z.string(),
  card_manual_punched: z.string(),
  card_manual_created: z.string(),
  card_difference: z.string(),
  card_result: z.enum(['TALLIED', 'SHORT', 'EXCESS']),
  card_reason: z.string(),
  card_comment: z.string(),
  district_system: z.string(),
  banking_amount: z.string(),
  closed_by: z.string(),
  closed_at: z.string(),
  closed_late: z.enum(['Yes', 'No']),
  last_verified_at: z.string().nullable(),
});
const resultSchema = z.object({
  reader: z.enum(['data', 'bigquery']),
  data: z.array(rowSchema),
  total: z.number(),
  page: z.number(),
  totalPages: z.number(),
});
interface Filters {
  from: string;
  to: string;
  stores: string[];
  attempts: 'all' | 'latest';
  search: string;
}
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
function initial(storeId: string): Filters {
  const to = today(),
    day = new Date(to + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() - 1);
  return {
    from: day.toISOString().slice(0, 10),
    to,
    stores: storeId ? [storeId] : [],
    attempts: 'all',
    search: '',
  };
}
const query = (filters: Filters, page: number, pageSize: number) =>
  params({
    from: filters.from,
    to: filters.to,
    storeIds: filters.stores.join(','),
    attempts: filters.attempts,
    search: filters.search,
    page: String(page),
    pageSize: String(pageSize),
  });
export function DayCloseHistoryPage({ user, storeId }: { user: Principal; storeId: string }) {
  const [filters, setFilters] = useState(() => initial(storeId)),
    [submitted, setSubmitted] = useState(() => initial(storeId)),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25);
  const stores = useQuery({
    queryKey: [user.id, 'finance-cash-ledger-stores'],
    queryFn: () =>
      request(
        '/api/v1/reports/store-cash-balances/stores',
        {},
        z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }),
      ),
  });
  const report = useQuery({
    queryKey: [user.id, 'finance-close-history', submitted, page, pageSize],
    queryFn: () =>
      request(
        `/api/v1/reports/day-close-history?${query(submitted, page, pageSize)}`,
        {},
        resultSchema,
      ),
    retry: false,
  });
  const download = useMutation({
    mutationFn: () =>
      downloadReportCsv(
        `/api/v1/reports/day-close-history/export?${query(submitted, 1, pageSize)}`,
        `day-close-history-${submitted.from}-${submitted.to}.csv`,
        user.id,
      ),
  });
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  return (
    <>
      <PageTitle eyebrow="THE RECORD BEHIND THE FIGURES" title="Day-close history">
        <button
          className="button secondary"
          disabled={!report.data?.total || download.isPending}
          onClick={() => download.mutate()}
        >
          <ArrowDownToLine size={16} />
          {download.isPending ? 'Preparing…' : 'Export filtered CSV'}
        </button>
      </PageTitle>
      <form
        className="surface history-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(filters);
          setPage(1);
        }}
      >
        <label>
          From
          <input
            type="date"
            required
            value={filters.from}
            onChange={(event) => update('from', event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            required
            min={filters.from}
            value={filters.to}
            onChange={(event) => update('to', event.target.value)}
          />
        </label>
        <label>
          Stores
          <select
            multiple
            value={filters.stores}
            onChange={(event) =>
              update(
                'stores',
                Array.from(event.target.selectedOptions, (option) => option.value),
              )
            }
          >
            {stores.data?.data.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
          <small>Clear to include every permitted store.</small>
        </label>
        <label>
          Attempts
          <select
            value={filters.attempts}
            onChange={(event) => update('attempts', event.target.value as Filters['attempts'])}
          >
            <option value="all">Every attempt</option>
            <option value="latest">Latest per store/day</option>
          </select>
        </label>
        <label>
          Search status, reason or comment
          <input
            value={filters.search}
            maxLength={100}
            onChange={(event) => update('search', event.target.value)}
          />
        </label>
        <button className="button primary" disabled={report.isFetching}>
          <Search size={16} />
          Apply filters
        </button>
      </form>
      {stores.isError && <ErrorState error={stores.error} />}{' '}
      {download.isError && <ErrorState error={download.error} />}{' '}
      {report.isPending ? (
        <Loading />
      ) : report.isError ? (
        <ErrorState error={report.error} retry={() => void report.refetch()} />
      ) : report.data.data.length === 0 ? (
        <Empty title="No close attempts found">Adjust the date, store, or search filters.</Empty>
      ) : (
        <>
          <div className="surface finance-history">
            <table>
              <thead>
                <tr>
                  {fields.map(([key, label]) => (
                    <th key={key}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.data.data.map((row) => (
                  <tr key={row.id}>
                    {fields.map(([key]) => (
                      <td key={key}>{row[key] === null || row[key] === '' ? '—' : row[key]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fulfillment-pagination">
            <button
              className="button secondary"
              disabled={report.data.page <= 1}
              onClick={() => setPage(report.data.page - 1)}
            >
              Previous
            </button>
            <span>
              {report.data.total} attempt(s) · Page {report.data.page} of {report.data.totalPages}
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
                {[10, 25, 50, 100, 500].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button
              className="button secondary"
              disabled={report.data.page >= report.data.totalPages}
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
