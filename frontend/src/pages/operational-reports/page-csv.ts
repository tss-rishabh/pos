import { captureOperatorScope } from '../../api/client';
import { csvCell } from '../reports';

/** Legacy DataTables "CSV" button: the visible columns of the rows currently loaded on screen. */
export function loadedPageCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  return '﻿' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
export function downloadLoadedPageCsv(
  ownerId: string,
  filename: string,
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
) {
  const actor = captureOperatorScope(ownerId);
  if (!headers.length) throw new Error('Choose at least one visible column.');
  const csv = loadedPageCsv(headers, rows);
  actor.throwIfAborted();
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
