import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, ArrowDownToLine } from 'lucide-react';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { queueReportExport, type ReportExportFilters } from './export-commands';
import './style.css';
interface ReportColumn<T> {
  key: keyof T;
  label: string;
  sort: string;
}
interface Filters {
  from: string;
  to: string;
  storeIds: string[];
  sort: string;
  direction: 'asc' | 'desc';
  search: string;
}
function initial(
  storeId: string,
  sort: string,
  dateOnly = false,
  direction: 'asc' | 'desc' = 'desc',
): Filters {
  const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
    prior = new Date(today + 'T00:00:00Z');
  prior.setUTCDate(prior.getUTCDate() - 7);
  return {
    from: prior.toISOString().slice(0, 10) + (dateOnly ? '' : 'T00:00:00'),
    to: today + (dateOnly ? '' : 'T23:59:59'),
    storeIds: storeId ? [storeId] : [],
    sort,
    direction,
    search: '',
  };
}
/** Shared report controls keep scope, paging and runtime DTO validation consistent. */
export function ReportView<T extends Record<string, unknown>>({
  user,
  storeId,
  title,
  path,
  resource,
  rowSchema,
  columns,
  defaultSort,
  allowedRoles = [1],
  searchable = false,
  requiresSelectedStores = false,
  exportKind,
  sortOptions,
  dateOnly = false,
  defaultDirection = 'desc',
  columnControls = true,
  fullExport = false,
}: {
  user: Principal;
  storeId: string;
  title: string;
  path: string;
  resource: string;
  rowSchema: z.ZodType<T>;
  columns: readonly ReportColumn<T>[];
  defaultSort: string;
  allowedRoles?: readonly Principal['role'][];
  searchable?: boolean;
  requiresSelectedStores?: boolean;
  exportKind?: ReportExportFilters['kind'];
  sortOptions?: readonly { value: string; label: string }[];
  dateOnly?: boolean;
  defaultDirection?: 'asc' | 'desc';
  columnControls?: boolean;
  fullExport?: boolean;
}) {
  const online = useOnline(),
    queryClient = useQueryClient(),
    permitted = allowedRoles.includes(user.role),
    [filters, setFilters] = useState(() =>
      initial(storeId, defaultSort, dateOnly, defaultDirection),
    ),
    [submitted, setSubmitted] = useState(() =>
      initial(storeId, defaultSort, dateOnly, defaultDirection),
    ),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25),
    [hidden, setHidden] = useState<readonly string[]>([]),
    visible = columns.filter((column) => !hidden.includes(String(column.key))),
    schema = z.object({
      reader: z.enum(['data', 'bigquery']),
      data: z.array(rowSchema),
      total: z.number(),
      page: z.number(),
      totalPages: z.number(),
    });
  const stores = useQuery({
      queryKey: [user.id, 'finance-cash-ledger-stores'],
      enabled: permitted,
      queryFn: () =>
        request(
          '/api/v1/reports/store-cash-balances/stores',
          {},
          z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }),
        ),
    }),
    report = useQuery({
      queryKey: [user.id, resource, submitted, page, pageSize],
      enabled: permitted,
      queryFn: ({ signal }) =>
        request(
          path,
          {
            method: 'POST',
            signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
            body: JSON.stringify({
              from: submitted.from,
              to: submitted.to,
              storeIds: submitted.storeIds,
              sort: submitted.sort,
              direction: submitted.direction,
              ...(searchable ? { search: submitted.search } : {}),
              page,
              pageSize,
            }),
          },
          schema,
        ),
      retry: false,
    });
  const createExport = useMutation({
    mutationFn: (variant: 'visible' | 'full') => {
      if (!exportKind) throw new Error('This report does not support queued exports.');
      return queueReportExport(user.id, {
        kind: exportKind,
        from: submitted.from,
        to: submitted.to,
        storeIds: submitted.storeIds,
        attempts: 'all',
        search: submitted.search,
        ...(columnControls && variant === 'visible'
          ? {
              sort: submitted.sort,
              direction: submitted.direction,
              columns: visible.map((column) => String(column.key)),
            }
          : {}),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [user.id, 'report-exports'] }),
  });
  const update = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  if (!permitted)
    return <ErrorState error={new Error('This report requires a permitted operator role.')} />;
  return (
    <>
      <PageTitle eyebrow="OPERATIONS IN FOCUS" title={title}>
        {exportKind && fullExport && (
          <button
            className="button secondary"
            disabled={!online || !report.data?.total || createExport.isPending}
            onClick={() => createExport.mutate('full')}
          >
            <ArrowDownToLine size={16} />
            Export complete CSV
          </button>
        )}
        {exportKind && (
          <button
            className="button secondary"
            disabled={!online || !report.data?.total || createExport.isPending || !visible.length}
            onClick={() => createExport.mutate('visible')}
          >
            <ArrowDownToLine size={16} />
            {createExport.isPending
              ? 'Requesting…'
              : columnControls
                ? 'Export visible columns CSV'
                : 'Export CSV'}
          </button>
        )}
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
            type={dateOnly ? 'date' : 'datetime-local'}
            step="1"
            required
            value={filters.from}
            onChange={(event) => update('from', event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type={dateOnly ? 'date' : 'datetime-local'}
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
          <small>
            {requiresSelectedStores || user.userType === 2
              ? 'Choose the stores to include.'
              : 'Clear the selection for all stores.'}
          </small>
        </label>
        <label>
          Sort by
          <select
            aria-label="Sort by"
            value={filters.sort}
            onChange={(event) => update('sort', event.target.value)}
          >
            {(
              sortOptions || columns.map((column) => ({ value: column.sort, label: column.label }))
            ).map((column, index) => (
              <option key={`${column.value}:${index}`} value={column.value}>
                {column.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Direction
          <select
            aria-label="Direction"
            value={filters.direction}
            onChange={(event) => update('direction', event.target.value === 'asc' ? 'asc' : 'desc')}
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
        {searchable && (
          <label>
            Search
            <input
              value={filters.search}
              maxLength={100}
              onChange={(event) => update('search', event.target.value)}
            />
          </label>
        )}
        <button className="button primary" disabled={!online || report.isFetching}>
          <Search size={16} />
          View report
        </button>
      </form>
      {exportKind && columnControls && (
        <p className="muted">
          CSV includes all matching records in the selected sort order and visible columns. Retrieve
          the file from Report exports.
        </p>
      )}
      {columnControls && (
        <details className="surface report-column-controls">
          <summary>
            Columns ({visible.length} of {columns.length})
          </summary>
          <div className="report-column-options">
            {columns.map((column) => (
              <label key={String(column.key)}>
                <input
                  type="checkbox"
                  checked={!hidden.includes(String(column.key))}
                  onChange={(event) =>
                    setHidden((current) =>
                      event.target.checked
                        ? current.filter((key) => key !== String(column.key))
                        : [...current, String(column.key)],
                    )
                  }
                />
                {column.label}
              </label>
            ))}
          </div>
          <button type="button" className="button secondary" onClick={() => setHidden([])}>
            Show all columns
          </button>
        </details>
      )}
      {stores.isError && <ErrorState error={stores.error} />}
      {createExport.isError && <ErrorState error={createExport.error} />}
      {createExport.isSuccess && (
        <p className="operational-report-success" role="status">
          Export requested. Its file will appear in Report exports.
        </p>
      )}
      {!online && (
        <p role="status">Showing available report data. Connect to refresh this report.</p>
      )}
      {report.isPending ? (
        <Loading />
      ) : report.isError ? (
        <ErrorState error={report.error} retry={() => void report.refetch()} />
      ) : !report.data.data.length ? (
        <Empty title="No records found">Choose another date range or store.</Empty>
      ) : (
        <>
          <p className="muted">{report.data.total.toLocaleString()} record(s)</p>
          <div className="surface resource-report-table">
            <table>
              <thead>
                <tr>
                  {visible.map((column) => (
                    <th key={String(column.key)}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.data.data.map((row, index) => (
                  <tr key={String(row.id ?? `${page}:${index}`)}>
                    {visible.map((column) => (
                      <td key={String(column.key)}>
                        {row[column.key] === null || row[column.key] === undefined
                          ? '—'
                          : String(row[column.key])}
                      </td>
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
                {[10, 25, 50, 100, 250, 500].map((size) => (
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
