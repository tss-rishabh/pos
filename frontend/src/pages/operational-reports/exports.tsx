import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, RefreshCw, Plus, Search } from 'lucide-react';
import { z } from 'zod';
import { captureOperatorScope, request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { downloadReportFile } from '../finance/download';
import {
  exportRowSchema,
  queueReportExport,
  timestampExport,
  type ReportExportFilters,
} from './export-commands';
import './style.css';
import {
  exportMetadataColumns,
  exportMetadataCsv,
  exportMetadataValue,
  type ExportMetadataColumn,
} from './export-metadata';
const resultSchema = z.object({
  data: z.array(exportRowSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
const businessToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
interface HistoryFilters {
  period: 'recent' | 'archive';
  from: string;
  to: string;
  search: string;
  sort:
    | 'id'
    | 'kind'
    | 'period'
    | 'message'
    | 'format'
    | 'requested_at'
    | 'completed_at'
    | 'report_name'
    | 'status'
    | 'requested_by'
    | 'row_count'
    | 'byte_count';
  direction: 'asc' | 'desc';
}
function initialHistory(): HistoryFilters {
  const to = businessToday(),
    start = new Date(to + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() - 30);
  return {
    period: 'recent',
    from: start.toISOString().slice(0, 10),
    to,
    search: '',
    sort: 'requested_at',
    direction: 'desc',
  };
}
export function ReportExportsPage({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    client = useQueryClient(),
    [origin, setOrigin] = useState<'current' | 'legacy'>('current'),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    [hiddenColumns, setHiddenColumns] = useState<readonly ExportMetadataColumn[]>([]),
    visibleColumns = exportMetadataColumns.filter(([key]) => !hiddenColumns.includes(key)),
    [historyFilters, setHistoryFilters] = useState(initialHistory),
    [submittedHistory, setSubmittedHistory] = useState(initialHistory),
    [filters, setFilters] = useState<ReportExportFilters>(() => ({
      kind: 'day-close-history',
      from: businessToday(),
      to: businessToday(),
      storeIds: storeId ? [storeId] : [],
      attempts: 'all',
      search: '',
    }));
  const stores = useQuery({
    queryKey: [user.id, 'finance-cash-ledger-stores'],
    queryFn: () =>
      request(
        '/api/v1/reports/store-cash-balances/stores',
        {},
        z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }),
      ),
  });
  const exports = useQuery({
    queryKey: [user.id, 'report-exports', origin, submittedHistory, page, pageSize],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/report-exports/search',
        {
          method: 'POST',
          body: JSON.stringify({ origin, ...submittedHistory, page, pageSize }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
        },
        resultSchema,
      ),
    retry: false,
    refetchInterval: (query) =>
      online &&
      query.state.data?.data.some((job) => ['QUEUED', 'BUILDING', 'STORING'].includes(job.status))
        ? 5000
        : false,
  });
  const metadataCsv = useMutation({
    mutationFn: async () => {
      const actor = captureOperatorScope(user.id),
        csv = exportMetadataCsv(
          exports.data?.data || [],
          visibleColumns.map(([key]) => key),
        );
      actor.throwIfAborted();
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
        link = document.createElement('a');
      link.href = url;
      link.download = `export-history-${origin}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  const create = useMutation({
      mutationFn: () => queueReportExport(user.id, filters),
      onSuccess: async () => {
        setOrigin('current');
        setPage(1);
        setHistoryFilters((current) => ({ ...current, period: 'recent', search: '' }));
        setSubmittedHistory((current) => ({ ...current, period: 'recent', search: '' }));
        await client.invalidateQueries({ queryKey: [user.id, 'report-exports'] });
      },
    }),
    download = useMutation({
      mutationFn: (job: z.infer<typeof exportRowSchema>) =>
        downloadReportFile(
          job.origin === 'legacy'
            ? `/api/v1/report-exports/legacy/${job.id}/file`
            : `/api/v1/report-exports/${job.id}/file`,
          job.origin === 'legacy'
            ? `legacy-report-${job.id}.${job.format.toUpperCase() === 'XLSX' ? 'xlsx' : 'csv'}`
            : job.kind === 'current-inventory-workbook'
              ? `inventory-${job.id}.xlsx`
              : job.kind === 'administration-list'
                ? `administration-${job.id}.csv`
                : `${job.kind}-${job.from}-${job.to}.csv`,
          user.id,
          job.format.toUpperCase() === 'XLSX' ? 'XLSX' : 'CSV',
        ),
    });
  const update = <K extends keyof ReportExportFilters>(key: K, value: ReportExportFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const selectKind = (kind: ReportExportFilters['kind']) =>
    setFilters((current) => ({
      ...current,
      kind,
      from: timestampExport(kind)
        ? current.from.includes('T')
          ? current.from
          : current.from + 'T00:00:00'
        : current.from.slice(0, 10),
      to: timestampExport(kind)
        ? current.to.includes('T')
          ? current.to
          : current.to + 'T23:59:59'
        : current.to.slice(0, 10),
    }));
  return (
    <>
      <PageTitle eyebrow="REPORTS, READY WHEN YOU ARE" title="Report exports">
        <button
          className="button secondary"
          disabled={!online || exports.isFetching}
          onClick={() => void exports.refetch()}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </PageTitle>
      <form
        className="surface export-request-form"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Report
          <select
            aria-label="Report"
            value={filters.kind}
            disabled={create.isPending}
            onChange={(event) =>
              selectKind(
                event.target.value === 'cash-balance'
                  ? 'cash-balance'
                  : event.target.value === 'returned-orders'
                    ? 'returned-orders'
                    : event.target.value === 'order-transactions'
                      ? 'order-transactions'
                      : event.target.value === 'hyperlocal-daily'
                        ? 'hyperlocal-daily'
                        : event.target.value === 'current-inventory-workbook'
                          ? 'current-inventory-workbook'
                          : event.target.value === 'flash-sales'
                            ? 'flash-sales'
                            : event.target.value === 'salesperson-performance'
                              ? 'salesperson-performance'
                              : event.target.value === 'cashier-performance'
                                ? 'cashier-performance'
                                : event.target.value === 'hyperlocal-acceptance'
                                  ? 'hyperlocal-acceptance'
                                  : 'day-close-history',
              )
            }
          >
            <option value="day-close-history">Day-close history</option>
            <option value="cash-balance">Store cash balances</option>
            <option value="returned-orders">Returned orders</option>
            <option value="order-transactions">Order transactions</option>
            <option value="hyperlocal-daily">Hyperlocal daily report</option>
            {user.role === 1 && (
              <>
                <option value="salesperson-performance">Salesperson performance</option>
                <option value="cashier-performance">Staff performance</option>
                <option value="hyperlocal-acceptance">Hyperlocal acceptance</option>
              </>
            )}
            <option value="flash-sales">Flash sales</option>
            <option value="current-inventory-workbook">Current inventory workbook (XLSX)</option>
          </select>
        </label>
        <label>
          Export name
          <input
            value={filters.label || ''}
            maxLength={255}
            disabled={create.isPending}
            onChange={(event) => update('label', event.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          Notes
          <input
            value={filters.note || ''}
            maxLength={255}
            disabled={create.isPending}
            onChange={(event) => update('note', event.target.value)}
            placeholder="Optional"
          />
        </label>
        {filters.kind !== 'current-inventory-workbook' && (
          <>
            <label>
              From
              <input
                type={timestampExport(filters.kind) ? 'datetime-local' : 'date'}
                step="1"
                required
                value={filters.from}
                disabled={create.isPending}
                onChange={(event) => update('from', event.target.value)}
              />
            </label>
            <label>
              To
              <input
                type={timestampExport(filters.kind) ? 'datetime-local' : 'date'}
                step="1"
                required
                value={filters.to}
                min={filters.from}
                disabled={create.isPending}
                onChange={(event) => update('to', event.target.value)}
              />
            </label>
          </>
        )}
        <label>
          Stores
          <select
            aria-label="Stores"
            multiple
            required={filters.kind === 'current-inventory-workbook'}
            value={filters.storeIds}
            disabled={create.isPending}
            onChange={(event) =>
              update(
                'storeIds',
                filters.kind === 'current-inventory-workbook'
                  ? [
                      ...filters.storeIds.filter((id) =>
                        Array.from(event.target.selectedOptions).some(
                          (option) => option.value === id,
                        ),
                      ),
                      ...Array.from(event.target.selectedOptions, (option) => option.value).filter(
                        (id) => !filters.storeIds.includes(id),
                      ),
                    ]
                  : Array.from(event.target.selectedOptions, (option) => option.value),
              )
            }
          >
            {stores.data?.data
              .filter(
                (store) =>
                  user.userType !== 2 ||
                  (!timestampExport(filters.kind) &&
                    filters.kind !== 'current-inventory-workbook') ||
                  user.storeIds.includes(store.id),
              )
              .map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
          </select>
          <small>
            {filters.kind === 'current-inventory-workbook'
              ? 'Select stores. Each selected store has its own sheet, in the order below.'
              : timestampExport(filters.kind)
                ? 'Choose the stores to include.'
                : 'Clear the selection for all permitted stores.'}
          </small>
        </label>
        {filters.kind === 'current-inventory-workbook' && (
          <div className="muted">
            <p>Current inventory snapshot. No date range is needed.</p>
            <ol aria-label="Workbook sheet order">
              {filters.storeIds.map((id, index) => (
                <li key={id}>
                  {stores.data?.data.find((store) => store.id === id)?.name || id}{' '}
                  <button
                    type="button"
                    className="button secondary"
                    aria-label={`Move store ${id} up`}
                    disabled={index === 0 || create.isPending}
                    onClick={() => {
                      const ids = [...filters.storeIds];
                      [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
                      update('storeIds', ids);
                    }}
                  >
                    Up
                  </button>{' '}
                  <button
                    type="button"
                    className="button secondary"
                    aria-label={`Move store ${id} down`}
                    disabled={index === filters.storeIds.length - 1 || create.isPending}
                    onClick={() => {
                      const ids = [...filters.storeIds];
                      [ids[index + 1], ids[index]] = [ids[index]!, ids[index + 1]!];
                      update('storeIds', ids);
                    }}
                  >
                    Down
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
        {filters.kind === 'order-transactions' && (
          <>
            <label>
              Order source
              <select
                value={filters.source || 'store'}
                disabled={create.isPending}
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
                value={filters.dateType || 'order_date'}
                disabled={create.isPending}
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
          </>
        )}
        {filters.kind === 'day-close-history' && (
          <>
            <label>
              Attempts
              <select
                value={filters.attempts}
                disabled={create.isPending}
                onChange={(event) =>
                  update('attempts', event.target.value === 'latest' ? 'latest' : 'all')
                }
              >
                <option value="all">All attempts</option>
                <option value="latest">Latest per store and day</option>
              </select>
            </label>
            <label>
              Search
              <input
                value={filters.search}
                maxLength={100}
                disabled={create.isPending}
                onChange={(event) => update('search', event.target.value)}
              />
            </label>
          </>
        )}
        {filters.kind === 'returned-orders' && (
          <label>
            Search
            <input
              value={filters.search}
              maxLength={100}
              disabled={create.isPending}
              onChange={(event) => update('search', event.target.value)}
            />
          </label>
        )}
        <button className="button primary" disabled={!online || create.isPending}>
          <Plus size={16} />
          {create.isPending ? 'Requesting…' : 'Request export'}
        </button>
      </form>
      <div className="export-history-controls">
        <label>
          Rows per page
          <select
            aria-label="Export history rows per page"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {[10, 25, 50, 100, 500].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button secondary"
          disabled={!exports.data?.data.length || !visibleColumns.length || metadataCsv.isPending}
          onClick={() => metadataCsv.mutate()}
        >
          Download visible metadata CSV
        </button>
        <details>
          <summary>
            Metadata columns ({visibleColumns.length} of {exportMetadataColumns.length})
          </summary>
          {exportMetadataColumns.map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={!hiddenColumns.includes(key)}
                onChange={(event) =>
                  setHiddenColumns((current) =>
                    event.target.checked
                      ? current.filter((value) => value !== key)
                      : [...current, key],
                  )
                }
              />
              {label}
            </label>
          ))}
          <button className="button secondary" type="button" onClick={() => setHiddenColumns([])}>
            Show all metadata columns
          </button>
        </details>
      </div>
      {metadataCsv.isError && <ErrorState error={metadataCsv.error} />}
      {!online && <p role="status">Connect to request or download report files.</p>}
      {stores.isError && <ErrorState error={stores.error} />}
      {create.isError && <ErrorState error={create.error} />}
      {create.isSuccess && (
        <p className="operational-report-success" role="status">
          Export requested. Its status appears below.
        </p>
      )}
      {download.isError && <ErrorState error={download.error} />}
      <div className="export-history-controls">
        <label>
          History
          <select
            aria-label="History"
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value === 'legacy' ? 'legacy' : 'current');
              setPage(1);
            }}
          >
            <option value="current">Current exports</option>
            <option value="legacy">Legacy exports</option>
          </select>
        </label>
        <span className="muted">{exports.data?.total || 0} export(s)</span>
      </div>
      <form
        className="surface export-history-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmittedHistory(historyFilters);
          setPage(1);
        }}
      >
        <label>
          Activity
          <select
            value={historyFilters.period}
            onChange={(event) =>
              setHistoryFilters((current) => ({
                ...current,
                period: event.target.value === 'archive' ? 'archive' : 'recent',
              }))
            }
          >
            <option value="recent">Recent and pending</option>
            <option value="archive">Archive</option>
          </select>
        </label>
        {historyFilters.period === 'archive' && (
          <>
            <label>
              Completed or failed from
              <input
                type="date"
                required
                value={historyFilters.from}
                onChange={(event) =>
                  setHistoryFilters((current) => ({ ...current, from: event.target.value }))
                }
              />
            </label>
            <label>
              To
              <input
                type="date"
                required
                value={historyFilters.to}
                min={historyFilters.from}
                onChange={(event) =>
                  setHistoryFilters((current) => ({ ...current, to: event.target.value }))
                }
              />
            </label>
          </>
        )}
        <label>
          Search
          <input
            value={historyFilters.search}
            maxLength={100}
            onChange={(event) =>
              setHistoryFilters((current) => ({ ...current, search: event.target.value }))
            }
          />
        </label>
        <label>
          Sort
          <select
            value={historyFilters.sort}
            onChange={(event) =>
              setHistoryFilters((current) => ({
                ...current,
                sort: z
                  .enum([
                    'id',
                    'kind',
                    'period',
                    'message',
                    'format',
                    'requested_at',
                    'completed_at',
                    'report_name',
                    'status',
                    'requested_by',
                    'row_count',
                    'byte_count',
                  ])
                  .parse(event.target.value),
              }))
            }
          >
            {[
              ['id', 'ID'],
              ['kind', 'Type'],
              ['period', 'Period'],
              ['message', 'Message'],
              ['format', 'Format'],
              ['requested_at', 'Requested'],
              ['completed_at', 'Completed'],
              ['report_name', 'Report name'],
              ['status', 'Status'],
              ['requested_by', 'Requested by'],
              ['row_count', 'Rows'],
              ['byte_count', 'Size'],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Direction
          <select
            value={historyFilters.direction}
            onChange={(event) =>
              setHistoryFilters((current) => ({
                ...current,
                direction: event.target.value === 'asc' ? 'asc' : 'desc',
              }))
            }
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
        <button className="button secondary" disabled={!online || exports.isFetching}>
          <Search size={16} />
          Apply
        </button>
      </form>
      <p className="muted">
        {submittedHistory.period === 'recent'
          ? 'Recent activity includes pending work and exports completed or failed within 24 hours.'
          : 'Archive shows completed and failed exports older than 24 hours in the selected range.'}
      </p>
      {origin === 'legacy' && (user.role !== 1 || user.userType !== 1) && (
        <p className="muted">
          Legacy files require an internal super administrator because their original store and
          privacy permissions were not recorded.
        </p>
      )}
      {exports.isPending ? (
        <Loading />
      ) : exports.isError ? (
        <ErrorState error={exports.error} retry={() => void exports.refetch()} />
      ) : !exports.data.data.length ? (
        <Empty title="No report exports">Request a report to prepare a downloadable file.</Empty>
      ) : (
        <>
          <div className="surface report-export-table">
            <table>
              <thead>
                <tr>
                  {visibleColumns.map(([key, label]) => (
                    <th key={key}>{label}</th>
                  ))}
                  <th>File</th>
                </tr>
              </thead>
              <tbody>
                {exports.data.data.map((job) => (
                  <tr key={`${job.origin}:${job.id}`}>
                    {visibleColumns.map(([key]) => (
                      <td key={key}>
                        {exportMetadataValue(job, key) ?? '—'}
                        {key === 'reportName' && job.note && <small>{job.note}</small>}
                      </td>
                    ))}
                    <td>
                      <button
                        className="button secondary"
                        disabled={!online || !job.canDownload || download.isPending}
                        onClick={() => download.mutate(job)}
                        aria-label={`Download ${job.reportName}`}
                      >
                        <ArrowDownToLine size={16} />
                        Download
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="export-history-controls">
            <button
              className="button secondary"
              disabled={page <= 1 || exports.isFetching}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </button>
            <span>
              Page {page} of {Math.max(1, Math.ceil(exports.data.total / pageSize))}
            </span>
            <button
              className="button secondary"
              disabled={page * pageSize >= exports.data.total || exports.isFetching}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </>
  );
}
