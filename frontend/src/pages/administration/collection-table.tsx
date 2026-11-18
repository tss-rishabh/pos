import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useOnline } from '../../hooks/use-pos';
import { Link } from 'react-router-dom';
import { captureOperatorScope } from '../../api/client';
import { Empty, ErrorState } from '../../components/common';
import { queueAdministrationCollectionExport } from '../operational-reports/export-commands';

export type AdministrationResource =
  'stores' | 'operators' | 'salespeople' | 'counters' | 'storage' | 'documentation';
export interface AdministrationViewOptions {
  pageSize: number;
  sort: string;
  direction: 'asc' | 'desc';
}
const viewSchema = z
  .object({
    pageSize: z.union([
      z.literal(10),
      z.literal(25),
      z.literal(50),
      z.literal(100),
      z.literal(500),
    ]),
    sort: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/),
    direction: z.enum(['asc', 'desc']),
  })
  .strict();
export function useAdministrationView(resource: AdministrationResource, ownerId: string) {
  const key = `pos-administration-view:${ownerId}:${resource}`;
  const [settings, setSettings] = useState<Record<string, AdministrationViewOptions>>({});
  const defaults: AdministrationViewOptions = {
    pageSize: 25,
    sort: resource === 'documentation' ? 'sortOrder' : 'id',
    direction: resource === 'documentation' ? 'desc' : 'asc',
  };
  let stored: AdministrationViewOptions | undefined;
  try {
    const raw = localStorage.getItem(key);
    if (raw) stored = viewSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    /* Only presentation preferences; corrupt storage never blocks the collection. */
  }
  const options = settings[key] ?? stored ?? defaults;
  const [index, setIndex] = useState(0);
  return {
    resource,
    options,
    index,
    setIndex,
    change: (next: Partial<AdministrationViewOptions>) => {
      setIndex(0);
      const updated = viewSchema.parse({ ...options, ...next });
      setSettings((previous) => ({ ...previous, [key]: updated }));
      try {
        localStorage.setItem(key, JSON.stringify(updated));
      } catch {
        /* Browsing works without persistent preferences. */
      }
    },
  };
}
export interface AdministrationColumn<T> {
  key: string;
  label: string;
  sort?: string;
  render?: (row: T) => ReactNode;
  value: (row: T) => string | number | boolean | null | undefined;
}
export interface AdministrationCollection<T> {
  data?: { pages: { data: T[]; nextCursor: string | null }[] };
  isFetching: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
}
function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function AdministrationCollectionTable<T extends { id: string }>({
  ownerId,
  view,
  collection,
  columns,
  actions,
  search,
  active,
  storeId,
  emptyTitle = 'No matching records',
}: {
  ownerId: string;
  view: ReturnType<typeof useAdministrationView>;
  collection: AdministrationCollection<T>;
  columns: readonly AdministrationColumn<T>[];
  actions: (row: T) => ReactNode;
  search: string;
  active: string;
  storeId?: string;
  emptyTitle?: string;
}) {
  const online = useOnline(),
    identity = JSON.stringify([ownerId, search, active, storeId, view.resource, view.options]),
    current = useRef(identity);
  current.current = identity;
  const preferenceKey = `pos-administration-columns:${ownerId}:${view.resource}`;
  const [selection, setSelection] = useState<string[] | null>(() => {
      try {
        const raw = localStorage.getItem(preferenceKey);
        if (!raw) return null;
        const saved = z
          .array(z.string())
          .min(1)
          .max(20)
          .parse(JSON.parse(raw) as unknown);
        const supported = saved.filter((key) => columns.some((column) => column.key === key));
        return supported.length ? supported : null;
      } catch {
        return null;
      }
    }),
    [problem, setProblem] = useState<unknown>(),
    [queued, setQueued] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => view.setIndex(0), [search, active, storeId, view.resource]);
  useEffect(() => {
    if (selection !== null)
      try {
        localStorage.setItem(preferenceKey, JSON.stringify(selection));
      } catch {
        /* No customer records or search values are stored. */
      }
  }, [preferenceKey, selection]);
  const visible = columns.filter((column) => selection === null || selection.includes(column.key)),
    pages = collection.data?.pages ?? [],
    page = pages[view.index],
    rows = page?.data ?? [];
  const sorts = [
    { key: 'id', label: 'ID' },
    ...columns
      .filter((column) => column.sort && column.sort !== 'id')
      .map((column) => ({ key: column.sort!, label: column.label })),
  ];
  async function next() {
    setBusy(true);
    setProblem(undefined);
    const original = identity;
    try {
      const signal = captureOperatorScope(ownerId);
      if (view.index + 1 >= pages.length) await collection.fetchNextPage();
      signal.throwIfAborted();
      if (current.current === original) view.setIndex(view.index + 1);
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  }
  async function exportAll() {
    setBusy(true);
    setProblem(undefined);
    const original = identity;
    try {
      const result = await queueAdministrationCollectionExport(ownerId, {
        kind: 'administration-list',
        resource: view.resource,
        storeIds: storeId ? [storeId] : [],
        search,
        active: active as 'true' | 'false' | 'all',
        sort: view.options.sort,
        direction: view.options.direction,
        columns: visible.map((column) => column.key),
      });
      if (current.current === original) setQueued(result.id);
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  }
  function exportPage() {
    try {
      captureOperatorScope(ownerId).throwIfAborted();
      const text =
          [
            visible.map((column) => csvCell(column.label)).join(','),
            ...rows.map((row) => visible.map((column) => csvCell(column.value(row))).join(',')),
          ].join('\r\n') + '\r\n',
        url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${view.resource}-page.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setProblem(error);
    }
  }
  return (
    <>
      <div className="administration-filters" aria-label={`${view.resource} collection controls`}>
        <label>
          Page size
          <select
            aria-label="Page size"
            value={view.options.pageSize}
            disabled={busy || collection.isFetching}
            onChange={(event) => view.change({ pageSize: Number(event.target.value) })}
          >
            {[10, 25, 50, 100, 500].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort by
          <select
            aria-label="Sort by"
            value={view.options.sort}
            disabled={busy || collection.isFetching}
            onChange={(event) => view.change({ sort: event.target.value })}
          >
            {sorts.map((sort) => (
              <option key={sort.key} value={sort.key}>
                {sort.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Direction
          <select
            aria-label="Sort direction"
            value={view.options.direction}
            disabled={busy || collection.isFetching}
            onChange={(event) =>
              view.change({ direction: event.target.value === 'desc' ? 'desc' : 'asc' })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
        <details>
          <summary>Columns</summary>
          {columns.map((column) => (
            <label key={column.key}>
              <input
                type="checkbox"
                checked={visible.includes(column)}
                disabled={visible.length === 1 && visible.includes(column)}
                onChange={(event) => {
                  const selected = visible.map((value) => value.key);
                  setSelection(
                    event.target.checked
                      ? [...selected, column.key]
                      : selected.filter((key) => key !== column.key),
                  );
                }}
              />
              {column.label}
            </label>
          ))}
        </details>
        <button className="button secondary" disabled={!rows.length || busy} onClick={exportPage}>
          Export visible page CSV
        </button>
        <button
          className="button secondary"
          disabled={!online || !rows.length || busy || collection.isFetching}
          onClick={() => void exportAll()}
        >
          Queue all matching CSV
        </button>
      </div>
      {problem !== undefined && <ErrorState error={problem} />}
      {queued && (
        <p role="status">
          CSV export queued. <Link to="/reports/exports">Open export archive</Link> · {queued}
        </p>
      )}
      <div className="table-wrap">
        <table className="administration-table">
          <thead>
            <tr>
              {visible.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {visible.map((column) => (
                  <td key={column.key}>{column.render?.(row) ?? column.value(row) ?? '—'}</td>
                ))}
                <td>
                  <div className="administration-table-actions">{actions(row)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty title={emptyTitle} />}
      </div>
      <div className="administration-actions">
        <button
          className="button secondary"
          disabled={view.index === 0 || busy || collection.isFetching}
          onClick={() => view.setIndex(view.index - 1)}
        >
          Previous page
        </button>
        <span>Page {view.index + 1}</span>
        <button
          className="button secondary"
          disabled={
            !online ||
            busy ||
            collection.isFetching ||
            !(view.index + 1 < pages.length || collection.hasNextPage)
          }
          onClick={() => void next()}
        >
          Next page
        </button>
      </div>
    </>
  );
}
