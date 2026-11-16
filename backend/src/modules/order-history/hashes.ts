import { createHash } from 'node:crypto';
import type { HistoryHeader, HistoryLine, HistoryStore } from './contracts.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function historyRowHash(fields: readonly (string | null)[]) {
  return digest(
    fields
      .map((value) => (value === null ? '-' : '+' + Buffer.from(value).toString('hex')))
      .join('|'),
  );
}
/** Two-level ordered SHA-256 bounds each aggregation; no lossy XOR/concatenation truncation. */
export function historyRowsHash(rows: readonly string[]) {
  const chunks: string[] = [];
  for (let index = 0; index < rows.length; index += 100)
    chunks.push(digest(rows.slice(index, index + 100).join('\n')));
  return digest(chunks.join('\n'));
}
export const headerFields = (h: HistoryHeader) => [
  'header',
  h.id,
  h.customerId,
  h.reference,
  h.first,
  h.last,
  h.amount,
  h.status,
  h.paymentStatus,
  h.paymentStatusId,
  h.createdAt,
];
export const storeFields = (s: HistoryStore) => ['store', s.id, s.orderId, s.storeId, s.counterId];
export const lineFields = (l: HistoryLine) => [
  'line',
  l.id,
  l.orderId,
  l.productId,
  l.name,
  l.quantity,
  l.amount,
  l.gst,
  l.status,
];
export function historyOrderHash(
  headers: readonly HistoryHeader[],
  stores: readonly HistoryStore[],
  lines: readonly HistoryLine[],
) {
  return historyRowsHash([
    ...headers.map((h) => historyRowHash(headerFields(h))),
    ...stores.map((s) => historyRowHash(storeFields(s))),
    ...lines.map((l) => historyRowHash(lineFields(l))),
  ]);
}
export const historyListRowHash = (header: HistoryHeader, store: HistoryStore) =>
  historyRowHash(['list', ...headerFields(header), ...storeFields(store)]);
export function historyCopyHash(
  headers: readonly Pick<HistoryHeader, 'id' | 'customerId' | 'createdAt'>[],
  stores: readonly HistoryStore[],
  lines: readonly Pick<HistoryLine, 'id' | 'orderId' | 'productId'>[],
) {
  return historyRowsHash([
    ...headers.map((h) => historyRowHash(['copy-header', h.id, h.customerId, h.createdAt])),
    ...stores.map((s) => historyRowHash(storeFields(s))),
    ...lines.map((l) => historyRowHash(['copy-line', l.id, l.orderId, l.productId])),
  ]);
}
