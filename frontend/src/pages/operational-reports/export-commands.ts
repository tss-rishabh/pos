import { z } from 'zod';
import { ApiError, captureOperatorScope, request } from '../../api/client';
export const exportRowSchema = z.object({
  id: z.string(),
  origin: z.enum(['current', 'legacy']),
  kind: z.string(),
  reportName: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  status: z.enum(['QUEUED', 'BUILDING', 'STORING', 'COMPLETED', 'FAILED']),
  message: z.string(),
  requestedBy: z.string(),
  requestedByName: z.string().optional(),
  requestedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  format: z.string(),
  byteCount: z.number().nullable(),
  rowCount: z.number().nullable(),
  canDownload: z.boolean(),
  note: z.string().nullable().optional(),
  period: z.string().nullable().optional(),
});
export interface ReportExportFilters {
  kind:
    | 'day-close-history'
    | 'cash-balance'
    | 'returned-orders'
    | 'order-transactions'
    | 'hyperlocal-daily'
    | 'flash-sales'
    | 'salesperson-performance'
    | 'cashier-performance'
    | 'hyperlocal-acceptance'
    | 'current-inventory-workbook';
  from: string;
  to: string;
  storeIds: string[];
  attempts: 'all' | 'latest';
  search: string;
  source?: 'store' | 'online';
  dateType?: 'order_date' | 'return_date';
  label?: string;
  note?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
  columns?: readonly string[];
}
export const timestampExport = (kind: ReportExportFilters['kind']) =>
  [
    'returned-orders',
    'order-transactions',
    'hyperlocal-daily',
    'salesperson-performance',
    'cashier-performance',
    'hyperlocal-acceptance',
  ].includes(kind);
export const screenColumnExport = (kind: ReportExportFilters['kind']) =>
  [
    'returned-orders',
    'order-transactions',
    'flash-sales',
    'salesperson-performance',
    'cashier-performance',
    'hyperlocal-acceptance',
  ].includes(kind);
type CommandStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const commandSchema = z
  .object({ commandId: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
/** Retain an immutable command after transport failures without saving report search text. */
export async function queueReportExport(
  ownerId: string,
  filters: ReportExportFilters,
  storage: CommandStorage = localStorage,
  send?: (commandId: string, input: unknown) => Promise<z.infer<typeof exportRowSchema>>,
) {
  const common = {
      kind: filters.kind,
      from:
        timestampExport(filters.kind) && filters.from.length === 16
          ? filters.from + ':00'
          : filters.from,
      to:
        timestampExport(filters.kind) && filters.to.length === 16 ? filters.to + ':00' : filters.to,
      storeIds:
        filters.kind === 'current-inventory-workbook'
          ? [...filters.storeIds]
          : [...new Set(filters.storeIds)].sort((a, b) =>
              BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
            ),
      ...(filters.label?.trim() ? { label: filters.label.trim() } : {}),
      ...(filters.note?.trim() ? { note: filters.note.trim() } : {}),
      ...(screenColumnExport(filters.kind)
        ? {
            ...(filters.sort === undefined ? {} : { sort: filters.sort }),
            ...(filters.direction === undefined ? {} : { direction: filters.direction }),
            ...(filters.columns === undefined ? {} : { columns: [...filters.columns] }),
          }
        : {}),
    },
    input =
      filters.kind === 'current-inventory-workbook'
        ? {
            kind: filters.kind,
            storeIds: common.storeIds,
            ...(common.label ? { label: common.label } : {}),
            ...(common.note ? { note: common.note } : {}),
          }
        : filters.kind === 'day-close-history'
          ? { ...common, attempts: filters.attempts, search: filters.search.trim() }
          : filters.kind === 'returned-orders'
            ? { ...common, search: filters.search.trim() }
            : filters.kind === 'order-transactions'
              ? {
                  ...common,
                  source: filters.source || 'store',
                  dateType: filters.dateType || 'order_date',
                }
              : common;
  return dispatchExportInput(ownerId, input, storage, send);
}
export interface AdministrationCollectionExportFilters {
  kind?: 'administration-list';
  resource: 'stores' | 'operators' | 'salespeople' | 'counters' | 'storage' | 'documentation';
  storeIds: string[];
  search: string;
  active: 'true' | 'false' | 'all';
  sort: string;
  direction: 'asc' | 'desc';
  columns: readonly string[];
  label?: string;
  note?: string;
}
/** Current collections have no fabricated report date or warehouse routing. */
export async function queueAdministrationCollectionExport(
  ownerId: string,
  filters: AdministrationCollectionExportFilters,
  storage: CommandStorage = localStorage,
  send?: (commandId: string, input: unknown) => Promise<z.infer<typeof exportRowSchema>>,
) {
  const input = {
    kind: 'administration-list',
    resource: filters.resource,
    storeIds: [...filters.storeIds],
    search: filters.search.trim(),
    active: filters.active,
    sort: filters.sort,
    direction: filters.direction,
    columns: [...filters.columns],
    ...(filters.label?.trim() ? { label: filters.label.trim() } : {}),
    ...(filters.note?.trim() ? { note: filters.note.trim() } : {}),
  };
  return dispatchExportInput(ownerId, input, storage, send);
}
async function dispatchExportInput(
  ownerId: string,
  input: unknown,
  storage: CommandStorage,
  send:
    ((commandId: string, input: unknown) => Promise<z.infer<typeof exportRowSchema>>) | undefined,
) {
  const actorSignal = send ? undefined : captureOperatorScope(ownerId);
  const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join(''),
    key = `pos-report-export-command:${ownerId}:${hash}`,
    raw = storage.getItem(key),
    prior = raw ? commandSchema.parse(JSON.parse(raw) as unknown) : null,
    command = prior || { commandId: crypto.randomUUID(), hash };
  actorSignal?.throwIfAborted();
  storage.setItem(key, JSON.stringify(command));
  try {
    const result = send
      ? await send(command.commandId, input)
      : await request(
          '/api/v1/report-exports',
          {
            method: 'POST',
            operatorId: ownerId,
            body: JSON.stringify({ commandId: command.commandId, input }),
          },
          exportRowSchema,
        );
    storage.removeItem(key);
    return result;
  } catch (error) {
    if (error instanceof ApiError && [400, 401, 403, 404, 409, 422, 429].includes(error.status))
      storage.removeItem(key);
    throw error;
  }
}
