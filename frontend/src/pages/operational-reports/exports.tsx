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
  reportExportKinds,
  timestampExport,
  type ReportExportFilters,
  type ReportExportKind,
  type ReportExportRow,
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
const sortSchema = z.enum([
  'id',
  'report_name',
  'report_type',
  'time_period',
  'export_status',
  'message',
  'export_requested_by',
  'export_requested_at',
  'export_completed_at',
  'export_format',
  'export_size',
  'export_rows_count',
  'created_at',
]);
const sortLabels: Record<z.infer<typeof sortSchema>, string> = {
  id: 'ID',
  report_name: 'Report name',
  report_type: 'Report type',
  time_period: 'Time period',
  export_status: 'Status',
  message: 'Message',
  export_requested_by: 'Requested by',
  export_requested_at: 'Requested at',
  export_completed_at: 'Completed at',
  export_format: 'Format',
  export_size: 'Size',
  export_rows_count: 'Rows',
  created_at: 'Created at',
};
interface HistoryFilters {
  search: string;
  sort: z.infer<typeof sortSchema>;
  direction: 'asc' | 'desc';
}
const initialHistory: HistoryFilters = { search: '', sort: 'id', direction: 'desc' };
const kindLabels: Record<ReportExportKind, string> = {
  'day-close-history': 'Day-close history',
  'cash-balance': 'Store cash balances',
  'returned-orders': 'Returned orders',
  'order-transactions': 'Order transactions',
  'hyperlocal-daily': 'Hyperlocal daily report',
  'flash-sales': 'Flash sales',
};
/** Kinds whose legacy task requires an explicit store selection. */
const selectedStoresRequired = (kind: ReportExportKind) =>
  kind === 'returned-orders' || kind === 'order-transactions' || kind === 'flash-sales';
export function ReportExportsPage({ user, storeId }: { user: Principal; storeId: string }) {
  const online = useOnline(),
    client = useQueryClient(),
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
    queryKey: [user.id, 'report-exports', submittedHistory, page, pageSize],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/report-exports/search',
        {
          method: 'POST',
          body: JSON.stringify({
            ...(submittedHistory.search.trim() ? { search: submittedHistory.search.trim() } : {}),
            sort: submittedHistory.sort,
            direction: submittedHistory.direction,
            page,
            pageSize,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
        },
        resultSchema,
      ),
    retry: false,
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
      link.download = `export-logs-page-${page}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  const create = useMutation({
      mutationFn: () => queueReportExport(user.id, filters),
      onSuccess: () => client.invalidateQueries({ queryKey: [user.id, 'report-exports'] }),
    }),
    download = useMutation({
      mutationFn: (job: ReportExportRow) => {
        const xlsx = job.format.toUpperCase() === 'XLSX';
        return downloadReportFile(
          `/api/v1/report-exports/${job.id}/file`,
          `report-${job.id}.${xlsx ? 'xlsx' : 'csv'}`,
          user.id,
          xlsx ? 'XLSX' : 'CSV',
        );
      },
    });
  const update = <K extends keyof ReportExportFilters>(key: K, value: ReportExportFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const selectKind = (kind: ReportExportKind) =>
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
      <PageTitle title="Report exports">
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
                reportExportKinds.find((kind) => kind === event.target.value) ||
                  'day-close-history',
              )
            }
          >
            {reportExportKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabels[kind]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Report name
          <input
            value={filters.label || ''}
            maxLength={255}
            disabled={create.isPending}
            onChange={(event) => update('label', event.target.value)}
            placeholder="Optional"
          />
        </label>
        <label>
          Report message
          <input
            value={filters.note || ''}
            maxLength={255}
            disabled={create.isPending}
            onChange={(event) => update('note', event.target.value)}
            placeholder="Optional"
          />
        </label>
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
        <label>
          Stores
          <select
            aria-label="Stores"
            multiple
            required={selectedStoresRequired(filters.kind)}
            value={[...filters.storeIds]}
            disabled={create.isPending}
            onChange={(event) =>
              update(
                'storeIds',
                Array.from(event.target.selectedOptions, (option) => option.value),
              )
            }
          >
            {stores.data?.data
              .filter(
                (store) =>
                  user.userType !== 2 ||
                  !timestampExport(filters.kind) ||
                  user.storeIds.includes(store.id),
              )
              .map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
          </select>
          <small>
            {selectedStoresRequired(filters.kind)
              ? 'Choose the stores to include.'
              : 'Clear the selection for all permitted stores.'}
          </small>
        </label>
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
          <label>
            Attempts
            <select
              value={filters.attempts || 'all'}
              disabled={create.isPending}
              onChange={(event) =>
                update('attempts', event.target.value === 'latest' ? 'latest' : 'all')
              }
            >
              <option value="all">All attempts</option>
              <option value="latest">Latest per store and day</option>
            </select>
          </label>
        )}
        <button className="button primary" disabled={!online || create.isPending}>
          <Plus size={16} />
          {create.isPending ? 'Requesting…' : 'Request export'}
        </button>
      </form>
      {!online && <p role="status">Connect to request or download report files.</p>}
      {stores.isError && <ErrorState error={stores.error} />}
      {create.isError && <ErrorState error={create.error} />}
      {create.isSuccess && (
        <p className="operational-report-success" role="status">
          {create.data.message}
        </p>
      )}
      <form
        className="surface export-history-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmittedHistory(historyFilters);
          setPage(1);
        }}
      >
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
                sort: sortSchema.parse(event.target.value),
              }))
            }
          >
            {sortSchema.options.map((value) => (
              <option key={value} value={value}>
                {sortLabels[value]}
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
          CSV
        </button>
        <details>
          <summary>
            Columns ({visibleColumns.length} of {exportMetadataColumns.length})
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
            Show all columns
          </button>
        </details>
        <span className="muted">{exports.data?.total || 0} export(s)</span>
      </div>
      {metadataCsv.isError && <ErrorState error={metadataCsv.error} />}
      {download.isError && <ErrorState error={download.error} />}
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
                  <tr key={job.id}>
                    {visibleColumns.map(([key]) => (
                      <td key={key}>
                        {exportMetadataValue(job, key) ?? '—'}
                        {key === 'status' && <small>{job.message}</small>}
                      </td>
                    ))}
                    <td>
                      <button
                        className="button secondary"
                        disabled={!online || !job.canDownload || download.isPending}
                        onClick={() => download.mutate(job)}
                        aria-label={`Download export ${job.id}`}
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
