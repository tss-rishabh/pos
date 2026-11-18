import type { z } from 'zod';
import type { exportRowSchema } from './export-commands';
import { csvCell } from '../reports';

export type ExportMetadata = z.infer<typeof exportRowSchema>;
export const exportMetadataColumns = [
  ['id', 'ID'],
  ['reportName', 'Report'],
  ['kind', 'Type'],
  ['period', 'Period'],
  ['status', 'Status'],
  ['message', 'Message'],
  ['requestedBy', 'Requested by'],
  ['requestedAt', 'Requested'],
  ['completedAt', 'Completed'],
  ['format', 'Format'],
  ['byteCount', 'Size'],
  ['rowCount', 'Rows'],
] as const;
export type ExportMetadataColumn = (typeof exportMetadataColumns)[number][0];
export function exportMetadataValue(
  row: ExportMetadata,
  field: ExportMetadataColumn,
): string | number | null {
  if (field === 'period')
    return (
      row.period ||
      (row.from && row.to
        ? `${row.from} – ${row.to}`
        : row.kind === 'current-inventory-workbook'
          ? 'Current snapshot'
          : row.kind === 'administration-list'
            ? 'Current collection'
            : 'Legacy report')
    );
  if (field === 'requestedBy') return row.requestedByName || row.requestedBy;
  if (field === 'byteCount')
    return row.byteCount === null ? null : `${(row.byteCount / 1024).toFixed(1)} KB`;
  if (field === 'requestedAt' || field === 'completedAt') {
    const value = row[field];
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
  }
  return row[field];
}
/** Original server-side DataTables CSV exports the authenticated, loaded page. */
export function exportMetadataCsv(
  rows: readonly ExportMetadata[],
  selected: readonly ExportMetadataColumn[],
): string {
  const keys = new Set(selected),
    columns = exportMetadataColumns.filter(([key]) => keys.has(key));
  if (
    rows.length > 500 ||
    !columns.length ||
    keys.size !== selected.length ||
    columns.length !== keys.size
  )
    throw new Error('Choose visible metadata columns and a page of up to 500 rows.');
  const csv =
    '\uFEFF' +
    [
      columns.map(([, label]) => label),
      ...rows.map((row) => columns.map(([key]) => exportMetadataValue(row, key))),
    ]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');
  if (new TextEncoder().encode(csv).byteLength > 4 * 1024 * 1024)
    throw new Error('This metadata page exceeds the CSV size limit.');
  return csv;
}
