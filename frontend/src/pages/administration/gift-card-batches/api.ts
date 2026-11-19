import { z } from 'zod';

const id = z.string().regex(/^[1-9]\d{0,18}$/);
export const batchBase = '/api/v1/gift-card-batches';
/** `GiftCardView` context: the cleaned delivery email. */
export const batchCapabilities = z.object({
  email: z.string().nullable(),
  generationAvailable: z.boolean(),
});
/** One `AjaxGiftCardListView` row (gift_card_datatable.py:66-77). */
export const batchRecord = z.object({
  id,
  size: z.number().int(),
  message: z.string().nullable(),
  completed: z.boolean(),
  blocked: z.boolean(),
  printed: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type BatchRecord = z.infer<typeof batchRecord>;
export const batchResult = z.object({
  batchId: id,
  status: z.literal('success'),
  message: z.string(),
});
export const batchList = z.object({
  draw: z.number().int(),
  recordsTotal: z.string().regex(/^\d+$/),
  recordsFiltered: z.string().regex(/^\d+$/),
  start: z.number().int().nonnegative(),
  length: z.number().int().min(1).max(500),
  data: z.array(batchRecord).max(500),
});
export type BatchSort = 'id' | 'size' | 'message' | 'created_by' | 'created_at';
export type BatchFilters = {
  search: string;
  start: number;
  length: number;
  sort: BatchSort;
  direction: 'asc' | 'desc';
};
/** Legacy DataTables columns and length menu (gift_card/index.html:99-108). */
export const batchColumns = [
  { id: 'id', label: 'ID' },
  { id: 'size', label: 'Size' },
  { id: 'message', label: 'Message' },
  { id: 'created_by', label: 'Created By' },
  { id: 'created_at', label: 'Created At' },
] as const;
export const batchLengths = [10, 25, 50, 100, 500] as const;

/** Legacy page validation (gift_card/index.html:240-258). Returns the warning, or null. */
export function validateBatchRequest(size: string, message: string): string | null {
  const value = Number.parseFloat(size);
  if (Number.isNaN(value)) return 'Please Enter Valid value';
  if (value <= 0) return 'Size must be greater than zero';
  if (value > 10000) return 'Size must be less than 10,000';
  if (!Number.isInteger(value)) return 'Please Enter Valid value';
  if (!message) return 'Please provide the message';
  return null;
}

/** DataTables CSV button: visible columns of the current page. */
export function batchListCsv(rows: readonly BatchRecord[]) {
  const quote = (value: string) =>
    '"' + (/^[\s\p{C}]*[=+\-@]/u.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
  const cell = (row: BatchRecord, column: (typeof batchColumns)[number]['id']) =>
    column === 'created_by'
      ? row.createdBy
      : column === 'created_at'
        ? row.createdAt
        : String(row[column] ?? '');
  return (
    [
      batchColumns.map((column) => quote(column.label)).join(','),
      ...rows.map((row) => batchColumns.map((column) => quote(cell(row, column.id))).join(',')),
    ].join('\r\n') + '\r\n'
  );
}
