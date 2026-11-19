import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { captureOperatorScope, request } from '../../../api/client';
import type { Principal } from '../../../api/types';
import { ErrorState, Loading } from '../../../components/common';
import {
  batchBase,
  batchColumns,
  batchLengths,
  batchList,
  batchListCsv,
  type BatchFilters,
  type BatchRecord,
} from './api';

/** "Activity Logs" DataTable (gift_card/index.html:52-155, gift_card_datatable.py). */
export function GiftCardBatchHistory({
  user,
  online,
  busy,
  onAction,
}: {
  user: Principal;
  online: boolean;
  busy: boolean;
  onAction: (batch: BatchRecord, action: 'print' | 'block' | 'active') => void;
}) {
  const draw = useRef(0);
  const [filters, setFilters] = useState<BatchFilters>({
      search: '',
      start: 0,
      length: 10,
      sort: 'id',
      direction: 'desc',
    }),
    [search, setSearch] = useState(''),
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
          body: JSON.stringify({ ...filters, draw: ++draw.current }),
        },
        batchList,
      ),
  });
  function sortBy(column: BatchFilters['sort']) {
    setFilters((current) => ({
      ...current,
      sort: column,
      direction: current.sort === column && current.direction === 'asc' ? 'desc' : 'asc',
      start: 0,
    }));
  }
  function exportCsv() {
    if (!history.data) return;
    try {
      captureOperatorScope(user.id).throwIfAborted();
      const blob = new Blob([batchListCsv(history.data.data)], { type: 'text/csv;charset=utf-8' }),
        url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'POS | Gift Card.csv';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      setError(failure);
    }
  }
  const page = history.data;
  return (
    <section className="surface gift-card-batch-panel">
      <h2>Activity Logs</h2>
      {error !== undefined && <ErrorState error={error} />}
      <div className="administration-actions">
        <label>
          Show
          <select
            aria-label="Gift card batch page size"
            value={filters.length}
            onChange={(event) =>
              setFilters({ ...filters, length: Number(event.target.value), start: 0 })
            }
          >
            {batchLengths.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button className="button secondary" disabled={!page?.data.length} onClick={exportCsv}>
          CSV
        </button>
        <button
          className="button secondary"
          disabled={!online || history.isFetching}
          onClick={() => void history.refetch()}
        >
          Reload Table
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFilters({ ...filters, search, start: 0 });
          }}
        >
          <label>
            Search
            <input
              aria-label="Search gift card batches"
              maxLength={255}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </form>
      </div>
      {history.isPending && online && <Loading />}
      {history.isError && <ErrorState error={history.error} retry={() => void history.refetch()} />}
      {page && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {batchColumns.map((column) => (
                    <th key={column.id}>
                      <button className="link-button" onClick={() => sortBy(column.id)}>
                        {column.label}
                        {filters.sort === column.id
                          ? filters.direction === 'asc'
                            ? ' ▲'
                            : ' ▼'
                          : ''}
                      </button>
                    </th>
                  ))}
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {page.data.map((batch) => (
                  <tr
                    key={batch.id}
                    className={batch.blocked ? 'gift-card-batch-blocked' : undefined}
                  >
                    <td>{batch.id}</td>
                    <td>{batch.size}</td>
                    <td>{batch.message ?? ''}</td>
                    <td>{batch.createdBy}</td>
                    <td>{batch.createdAt}</td>
                    <td className="gift-card-batch-actions">
                      {batch.completed ? (
                        <>
                          {batch.printed ? (
                            <button className="button secondary" disabled>
                              Printed
                            </button>
                          ) : (
                            <button
                              className="button secondary"
                              aria-label={`Mark collection ${batch.id} as printed`}
                              disabled={!online || busy}
                              onClick={() => onAction(batch, 'print')}
                            >
                              Print
                            </button>
                          )}
                          <button
                            className="button secondary"
                            aria-label={
                              batch.blocked
                                ? `Activate collection ${batch.id}`
                                : `Block collection ${batch.id}`
                            }
                            disabled={!online || busy}
                            onClick={() => onAction(batch, batch.blocked ? 'active' : 'block')}
                          >
                            {batch.blocked ? 'Unblock' : 'Block'}
                          </button>
                        </>
                      ) : (
                        <span role="status" aria-label={`Collection ${batch.id} is generating`}>
                          Generating…
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.data.length === 0 && <p>No data available in table</p>}
          <p>
            Showing {page.data.length ? page.start + 1 : 0} to {page.start + page.data.length} of{' '}
            {page.recordsFiltered} entries
          </p>
          <div className="administration-actions">
            <button
              className="button secondary"
              disabled={!online || page.start === 0}
              onClick={() => setFilters({ ...filters, start: 0 })}
            >
              First
            </button>
            <button
              className="button secondary"
              disabled={!online || page.start === 0}
              onClick={() =>
                setFilters({ ...filters, start: Math.max(0, page.start - page.length) })
              }
            >
              Previous
            </button>
            <button
              className="button secondary"
              disabled={!online || BigInt(page.start + page.length) >= BigInt(page.recordsFiltered)}
              onClick={() => setFilters({ ...filters, start: page.start + page.length })}
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
