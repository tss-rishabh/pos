import { useEffect, useState, type ReactNode } from 'react';
import { csvCell } from '../reports';
export interface CatalogColumn<T> {
  key: keyof T;
  label: string;
  render?: (row: T) => ReactNode;
  exportValue?: (row: T) => unknown;
}
export function downloadCatalogCsv<T>(
  name: string,
  columns: readonly CatalogColumn<T>[],
  rows: readonly T[],
) {
  const csv =
    '\uFEFF' +
    [
      columns.map((column) => column.label),
      ...rows.map((row) =>
        columns.map((column) => (column.exportValue ? column.exportValue(row) : row[column.key])),
      ),
    ]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');
  downloadCatalogFile(name, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
}
export function downloadCatalogFile(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function CatalogTable<T extends { id: string }>({
  columns,
  rows,
  name,
  description,
  extra,
  ownerId,
  csv = true,
}: {
  columns: readonly CatalogColumn<T>[];
  rows: readonly T[];
  name: string;
  description?: string;
  extra?: ReactNode | ((visible: readonly CatalogColumn<T>[]) => ReactNode);
  ownerId?: string;
  csv?: boolean;
}) {
  const storageKey = ownerId ? 'pos:catalog-columns:' + ownerId + ':' + name : null;
  const [hidden, setHidden] = useState<string[]>(() => {
      if (!storageKey) return [];
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
        return Array.isArray(parsed)
          ? parsed.filter(
              (value): value is string =>
                typeof value === 'string' && columns.some((column) => String(column.key) === value),
            )
          : [];
      } catch {
        return [];
      }
    }),
    visible = columns.filter((column) => !hidden.includes(String(column.key)));
  useEffect(() => {
    if (storageKey)
      try {
        localStorage.setItem(storageKey, JSON.stringify(hidden));
      } catch {
        /* Layout storage must not prevent online or offline catalog reads. */
      }
  }, [storageKey, hidden]);
  return (
    <section className="surface catalog-results">
      <div className="catalog-table-toolbar">
        <p className="muted">{description}</p>
        {csv && (
          <button
            className="button secondary"
            disabled={!rows.length || !visible.length}
            onClick={() => downloadCatalogCsv(name, visible, rows)}
          >
            Export visible rows CSV
          </button>
        )}
        {typeof extra === 'function' ? extra(visible) : extra}
        <details>
          <summary>Columns</summary>
          <div className="catalog-columns">
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
        </details>
      </div>
      <div className="catalog-scroll">
        <table>
          <thead>
            <tr>
              {visible.map((column) => (
                <th key={String(column.key)}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {visible.map((column) => (
                  <td key={String(column.key)}>
                    {column.render ? column.render(row) : String(row[column.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
export function CatalogPagination({
  start,
  total,
  length,
  busy,
  onStart,
  onLength,
  lengthOptions = [10, 25, 50, 100, 500],
}: {
  start: number;
  total: number;
  length: number;
  busy: boolean;
  onStart: (value: number) => void;
  onLength: (value: number) => void;
  lengthOptions?: readonly number[];
}) {
  return (
    <div className="catalog-pagination">
      <button
        className="button secondary"
        disabled={busy || start === 0}
        onClick={() => onStart(0)}
      >
        First
      </button>
      <button
        className="button secondary"
        disabled={busy || start === 0}
        onClick={() => onStart(Math.max(0, start - length))}
      >
        Previous
      </button>
      <span>
        {total
          ? `${start + 1}–${Math.min(start + length, total)} of ${total.toLocaleString()}`
          : '0 records'}
      </span>
      <label>
        Rows
        <select value={length} onChange={(event) => onLength(Number(event.target.value))}>
          {lengthOptions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <button
        className="button secondary"
        disabled={busy || start + length >= total}
        onClick={() => onStart(start + length)}
      >
        Next
      </button>
      <button
        className="button secondary"
        disabled={busy || start + length >= total}
        onClick={() => onStart(Math.floor((total - 1) / length) * length)}
      >
        Last
      </button>
    </div>
  );
}
