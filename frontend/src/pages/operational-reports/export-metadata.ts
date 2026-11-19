import type { ReportExportRow } from './export-commands';
import { csvCell } from '../reports';

export type ExportMetadata = ReportExportRow;
/** Legacy export log columns (export_datatable.py) in source order. */
export const exportMetadataColumns = [
  ['id', 'ID'],
  ['reportName', 'Report name'],
  ['kind', 'Report type'],
  ['period', 'Time period'],
  ['status', 'Status'],
  ['note', 'Message'],
  ['requestedBy', 'Requested by'],
  ['requestedAt', 'Requested at'],
  ['completedAt', 'Completed at'],
  ['format', 'Format'],
  ['sizeKb', 'Size'],
  ['rowCount', 'Rows'],
] as const;
export type ExportMetadataColumn = (typeof exportMetadataColumns)[number][0];
export function exportMetadataValue(
  row: ExportMetadata,
  field: ExportMetadataColumn,
): string | number | null {
  if (field === 'status') return row.exportStatus || row.status;
  if (field === 'requestedBy') return row.requestedByName || row.requestedBy;
  // Legacy shows "{export_size} KB", and "-" for an empty size.
  if (field === 'sizeKb') return row.sizeKb ? `${row.sizeKb} KB` : '-';
  if (field === 'requestedAt' || field === 'completedAt') {
    const value = row[field];
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
  }
  return row[field];
}
/** DataTables CSV of the visible columns of the loaded export-log page. */
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
    '﻿' +
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
