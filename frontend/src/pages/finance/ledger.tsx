import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowRight } from 'lucide-react';
import { z } from 'zod';
import { params, request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { csvCell } from '../reports';
import { queueReportExport } from '../operational-reports/export-commands';
import { useOnline } from '../../hooks/use-pos';
import {
  ledgerColumns as columns,
  ledgerExportHeaders as exportHeaders,
  ledgerRowSchema as rowSchema,
  selectLedgerRows,
  type LedgerSort,
} from './ledger-rows';
import './style.css';
const resultSchema = z.object({
  reader: z.enum(['data', 'bigquery']),
  range: z.object({ from: z.string(), to: z.string(), today: z.string() }),
  data: z.array(rowSchema),
});
export function CashLedgerPage({ user, storeId }: { user: Principal; storeId: string }) {
  const client = useQueryClient(),
    [exportName, setExportName] = useState(''),
    [exportNote, setExportNote] = useState(''),
    online = useOnline(),
    [search, setSearch] = useState(''),
    [sort, setSort] = useState<LedgerSort>('source'),
    [direction, setDirection] = useState<'asc' | 'desc'>('asc'),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(31),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [selected, setSelected] = useState<string[]>(storeId ? [storeId] : []),
    [submitted, setSubmitted] = useState<{ from: string; to: string; stores: string[] } | null>(
      null,
    );
  const stores = useQuery({
    queryKey: [user.id, 'finance-cash-ledger-stores'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/reports/store-cash-balances/stores',
        { signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) },
        z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }),
      ),
  });
  const report = useQuery({
    queryKey: [user.id, 'finance-cash-ledger', submitted],
    enabled: submitted !== null,
    queryFn: ({ signal }) =>
      request(
        `/api/v1/reports/store-cash-balances?${params({ storeIds: submitted!.stores.join(','), from: submitted!.from || undefined, to: submitted!.to || undefined })}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) },
        resultSchema,
      ),
    retry: false,
  });
  const visible = useMemo(
    () => selectLedgerRows(report.data?.data || [], search, sort, direction, page, pageSize),
    [report.data, search, sort, direction, page, pageSize],
  );
  const createExport = useMutation({
    mutationFn: () => {
      if (!report.data || !submitted)
        throw new Error('View a ledger before requesting its export.');
      return queueReportExport(user.id, {
        kind: 'cash-balance',
        from: report.data.range.from,
        to: report.data.range.to,
        storeIds: submitted.stores,
        attempts: 'all',
        search: '',
        label: exportName,
        note: exportNote,
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: [user.id, 'report-exports'] }),
  });
  function download() {
    if (!report.data) return;
    const rows = [
        exportHeaders,
        ...visible.filtered.map((row) => columns.map(([key]) => row[key])),
      ],
      csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'),
      link = document.createElement('a'),
      url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.href = url;
    link.download = `store-cash-balances-${report.data.range.from}-${report.data.range.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <PageTitle eyebrow="EVERY DAY, CONNECTED" title="Cash balance ledger">
        <button
          className="button secondary"
          onClick={download}
          disabled={!report.data?.data.length}
        >
          <ArrowDownToLine size={16} />
          Download filtered CSV
        </button>
      </PageTitle>
      <form
        className="surface ledger-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted({ from, to, stores: selected });
          setPage(1);
        }}
      >
        <label>
          From
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          <small>Defaults to the first day of this month.</small>
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          <small>Defaults to today.</small>
        </label>
        <label>
          Stores
          <select
            multiple
            value={selected}
            onChange={(event) =>
              setSelected(Array.from(event.target.selectedOptions, (option) => option.value))
            }
          >
            {stores.data?.data.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
          <small>Clear the selection to include all permitted stores.</small>
        </label>
        <button className="button primary" disabled={!online || report.isFetching}>
          View ledger
          <ArrowRight size={16} />
        </button>
      </form>
      {report.data && (
        <div className="surface ledger-display-controls">
          <label>
            Search ledger
            <input
              value={search}
              maxLength={100}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            Sort by
            <select
              value={sort}
              onChange={(event) => {
                setSort(
                  z
                    .enum([
                      'source',
                      'store_name',
                      'date',
                      'opening_cash',
                      'sales_cash',
                      'running_total',
                      'actual_cash',
                      'difference',
                      'banking_amount',
                      'closing_balance',
                      'status',
                      'note',
                    ])
                    .parse(event.target.value),
                );
                setPage(1);
              }}
            >
              <option value="source">Ledger order</option>
              {columns.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Direction
            <select
              value={direction}
              onChange={(event) => {
                setDirection(event.target.value === 'desc' ? 'desc' : 'asc');
                setPage(1);
              }}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </label>
        </div>
      )}
      {report.data && (
        <details className="surface ledger-export-request">
          <summary>Request a full export</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              createExport.mutate();
            }}
          >
            <label>
              Report name
              <input
                required
                maxLength={255}
                value={exportName}
                disabled={createExport.isPending}
                onChange={(event) => setExportName(event.target.value)}
              />
            </label>
            <label>
              Report notes
              <input
                required
                maxLength={255}
                value={exportNote}
                disabled={createExport.isPending}
                onChange={(event) => setExportNote(event.target.value)}
              />
            </label>
            <p className="muted">
              Includes all ledger rows for the selected stores and date range.
            </p>
            <button className="button secondary" disabled={!online || createExport.isPending}>
              Request export
            </button>
          </form>
          {createExport.isError && <ErrorState error={createExport.error} />}{' '}
          {createExport.isSuccess && (
            <p role="status">
              Export requested. <a href="/reports/exports">View report exports</a>.
            </p>
          )}
        </details>
      )}
      {stores.isError && <ErrorState error={stores.error} />}
      <p className="muted">
        Balances follow opening anchors and closed days. An unclosed day pauses the balance until
        the next opening anchor.
      </p>
      {!submitted ? (
        <Empty title="Follow the cash balance">
          Choose stores and a date range to inspect the running cash ledger.
        </Empty>
      ) : report.isPending ? (
        <Loading />
      ) : report.isError ? (
        <ErrorState error={report.error} retry={() => void report.refetch()} />
      ) : report.data.data.length === 0 ? (
        <Empty title="No opening balance found">
          This range has no cash opening anchor for the selected stores.
        </Empty>
      ) : (
        <>
          <p>
            {report.data.range.from} through {report.data.range.to} · {report.data.data.length}{' '}
            row(s) · {visible.total} match(es)
          </p>
          <div className="surface finance-history">
            <table>
              <thead>
                <tr>
                  {columns.map(([key, label]) => (
                    <th key={key}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.data.map((row) => (
                  <tr key={`${row.store_id}:${row.date}`}>
                    {columns.map(([key]) => (
                      <td
                        key={key}
                        className={
                          key === 'difference' &&
                          row.difference &&
                          row.difference !== '0.00' &&
                          row.difference !== '-0.00'
                            ? row.difference.startsWith('-')
                              ? 'ledger-negative'
                              : 'ledger-positive'
                            : undefined
                        }
                      >
                        {key === 'status' ? (
                          <span className={'ledger-status ' + row.status.toLowerCase()}>
                            {row.status === 'NOT_CLOSED' ? 'Not closed' : row.status}
                          </span>
                        ) : row[key] === null ? (
                          '—'
                        ) : (
                          row[key]
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!visible.total && <Empty title="No matching ledger rows">Try another search.</Empty>}
          <div className="ledger-pagination">
            <button
              className="button secondary"
              disabled={visible.page <= 1}
              onClick={() => setPage(visible.page - 1)}
            >
              Previous
            </button>
            <span>
              Page {visible.page} of {Math.max(1, visible.totalPages)}
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
                {[31, 62, 100, 500].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button secondary"
              disabled={visible.page >= visible.totalPages}
              onClick={() => setPage(visible.page + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </>
  );
}
