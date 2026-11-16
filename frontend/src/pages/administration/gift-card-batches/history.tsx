import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { captureOperatorScope, request } from '../../../api/client';
import type { Principal } from '../../../api/types';
import { ErrorState, Loading } from '../../../components/common';
import {
  batchBase,
  batchHistory,
  batchColumns,
  batchStatus,
  batchHistoryCsv,
  readBatchPreferences,
  type BatchColumn,
  type BatchFilters,
} from './api';

export function GiftCardBatchHistory({
  user,
  online,
  today,
  busy,
  onSelect,
}: {
  user: Principal;
  online: boolean;
  today?: string;
  busy: boolean;
  onSelect: (id: string) => void;
}) {
  const [initial] = useState(() => readBatchPreferences(user.id)),
    viewOperationId = useRef(crypto.randomUUID());
  const [columns, setColumns] = useState<BatchColumn[]>(initial.columns),
    [filters, setFilters] = useState<BatchFilters>({
      from: null,
      to: null,
      search: '',
      start: 0,
      length: initial.length,
      sort: initial.sort,
      direction: initial.direction,
    }),
    [search, setSearch] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [error, setError] = useState<unknown>();
  const history = useQuery({
    queryKey: [user.id, 'gift-card-batches', 'history', filters],
    enabled: online,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) =>
      request(
        batchBase + '/search',
        {
          method: 'POST',
          operatorId: user.id,
          signal,
          cache: 'no-store',
          body: JSON.stringify({ ...filters, viewOperationId: viewOperationId.current }),
        },
        batchHistory,
      ),
  });
  useEffect(() => {
    try {
      captureOperatorScope(user.id).throwIfAborted();
      localStorage.setItem(
        'pos.gift-card-batches.preferences.' + user.id,
        JSON.stringify({
          columns,
          length: filters.length,
          sort: filters.sort,
          direction: filters.direction,
        }),
      );
    } catch {
      /* Preferences must not prevent browsing. */
    }
  }, [user.id, columns, filters.length, filters.sort, filters.direction]);
  function apply(next: BatchFilters) {
    if (Boolean(next.from) !== Boolean(next.to) || (next.from && next.to && next.from > next.to)) {
      setError(new Error('Choose both dates in order, or all history.'));
      return;
    }
    setError(undefined);
    if (JSON.stringify(next) === JSON.stringify(filters)) void history.refetch();
    setFilters(next);
  }
  function exportCsv() {
    if (!history.data) return;
    try {
      captureOperatorScope(user.id).throwIfAborted();
      const blob = new Blob([batchHistoryCsv(history.data.data, columns)], {
          type: 'text/csv;charset=utf-8',
        }),
        url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'gift-card-batch-history.csv';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <section className="surface gift-card-batch-panel">
      <h2>Batch history</h2>
      {error !== undefined && <ErrorState error={error} />}
      <div className="administration-actions">
        <button
          className="button secondary"
          disabled={!online || history.isFetching}
          onClick={() => void history.refetch()}
        >
          Reload table
        </button>
        <button
          className="button secondary"
          disabled={!history.data?.data.length}
          onClick={exportCsv}
        >
          Export current page CSV
        </button>
        <details>
          <summary>Columns</summary>
          {batchColumns.map((column) => (
            <label key={column.id}>
              <input
                type="checkbox"
                checked={columns.includes(column.id)}
                disabled={columns.length === 1 && columns.includes(column.id)}
                onChange={(event) =>
                  setColumns((current) =>
                    event.target.checked
                      ? batchColumns
                          .filter((item) => item.id === column.id || current.includes(item.id))
                          .map((item) => item.id)
                      : current.filter((id) => id !== column.id),
                  )
                }
              />
              {column.label}
            </label>
          ))}
        </details>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply({ ...filters, search, from: from || null, to: to || null, start: 0 });
        }}
      >
        <div className="administration-fields">
          <label>
            Search
            <input
              aria-label="Search gift card batches"
              maxLength={255}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label>
            From
            <input
              aria-label="Gift card batches from date"
              type="date"
              min="1000-01-01"
              max="9999-12-31"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            To
            <input
              aria-label="Gift card batches to date"
              type="date"
              min="1000-01-01"
              max="9999-12-31"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <label>
            Sort
            <select
              aria-label="Gift card batch sort"
              value={filters.sort}
              onChange={(event) =>
                apply({ ...filters, sort: event.target.value as BatchFilters['sort'], start: 0 })
              }
            >
              <option value="id">Batch number</option>
              <option value="size">Card count</option>
              <option value="message">Message</option>
              <option value="createdBy">Creator ID</option>
              <option value="createdAt">Created time</option>
            </select>
          </label>
          <label>
            Order
            <select
              aria-label="Gift card batch sort direction"
              value={filters.direction}
              onChange={(event) =>
                apply({
                  ...filters,
                  direction: event.target.value as BatchFilters['direction'],
                  start: 0,
                })
              }
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </label>
          <label>
            Rows
            <select
              aria-label="Gift card batch page size"
              value={filters.length}
              onChange={(event) =>
                apply({ ...filters, length: Number(event.target.value), start: 0 })
              }
            >
              {[10, 25, 50, 100, 500].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="administration-actions">
          <button className="button primary" disabled={!online}>
            Apply filters
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={!online || !today}
            onClick={() => {
              if (!today) return;
              setFrom(today);
              setTo(today);
              apply({ ...filters, search, from: today, to: today, start: 0 });
            }}
          >
            Today
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={!online}
            onClick={() => {
              setFrom('');
              setTo('');
              apply({ ...filters, search, from: null, to: null, start: 0 });
            }}
          >
            All history
          </button>
        </div>
      </form>
      {history.isPending && online && <Loading />}
      {history.isError && <ErrorState error={history.error} retry={() => void history.refetch()} />}
      {history.data && (
        <>
          <p>
            {history.data.recordsFiltered} batches ·{' '}
            {history.data.reader === 'bigquery' ? 'Historical reader' : 'Today’s report reader'}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column}>{batchColumns.find((item) => item.id === column)!.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.data.data.map((batch) => (
                  <tr
                    key={batch.id}
                    className={batch.blocked ? 'gift-card-batch-blocked' : undefined}
                  >
                    {columns.map((column) => (
                      <td key={column}>
                        {column === 'id' ? (
                          <button
                            className="button secondary"
                            disabled={!online || busy}
                            onClick={() => onSelect(batch.id)}
                          >
                            {batch.id}
                          </button>
                        ) : column === 'status' ? (
                          batchStatus(batch)
                        ) : column === 'size' ? (
                          batch.size.toLocaleString()
                        ) : (
                          batch[column] || ''
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {history.data.data.length === 0 && <p>No batches match these filters.</p>}
          <div className="administration-actions">
            <button
              className="button secondary"
              disabled={!online || history.data.start === 0}
              onClick={() =>
                apply({
                  ...filters,
                  start: Math.max(0, history.data.start - history.data.length),
                })
              }
            >
              Previous
            </button>
            <button
              className="button secondary"
              disabled={
                !online ||
                !Number.isSafeInteger(history.data.start + history.data.length) ||
                BigInt(history.data.start) + BigInt(history.data.length) >=
                  BigInt(history.data.recordsFiltered)
              }
              onClick={() => apply({ ...filters, start: history.data.start + history.data.length })}
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
