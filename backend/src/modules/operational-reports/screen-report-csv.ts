import { reportCsvCell } from './export-domain.js';
import { AppError } from '../../domain/errors.js';
import {
  reportColumnSelection,
  reportScreenColumns,
  type ReportScreenKind,
} from './export-presentation.js';

/** All matching rows, in the report's selected order and original column order. */
export function screenReportCsv(
  kind: ReportScreenKind,
  rows: readonly Readonly<Record<string, unknown>>[],
  selected?: readonly string[],
  maxBytes = 64 * 1024 * 1024,
): string {
  const selection = reportColumnSelection(kind).parse(selected),
    columns = reportScreenColumns[kind].filter(([key]) => !selection || selection.includes(key)),
    lines: string[] = [];
  let bytes = 3;
  const append = (values: readonly unknown[]) => {
    const line = values.map(reportCsvCell).join(',');
    bytes += Buffer.byteLength(line, 'utf8') + (lines.length ? 2 : 0);
    if (bytes > maxBytes)
      throw new AppError(422, 'EXPORT_TOO_LARGE', 'Select a smaller store/date range for export.');
    lines.push(line);
  };
  append(columns.map(([, label]) => label));
  for (const row of rows) append(columns.map(([key]) => row[key]));
  return '\uFEFF' + lines.join('\r\n');
}
