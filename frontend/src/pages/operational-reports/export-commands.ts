import { z } from 'zod';
import { request } from '../../api/client';

/** One `report_exports` row as listed by the legacy export log (export_datatable.py). */
export const exportRowSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/),
  kind: z.string(),
  reportName: z.string(),
  note: z.string(),
  period: z.string().nullable(),
  status: z.enum(['QUEUED', 'COMPLETED', 'FAILED']),
  exportStatus: z.string().nullable(),
  message: z.string(),
  requestedBy: z.string(),
  requestedByName: z.string(),
  requestedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  format: z.string(),
  sizeKb: z.number(),
  rowCount: z.number(),
  canDownload: z.boolean(),
});
export type ReportExportRow = z.infer<typeof exportRowSchema>;

/** The six legacy export actions (E1-E6). */
export const reportExportKinds = [
  'returned-orders',
  'order-transactions',
  'hyperlocal-daily',
  'cash-balance',
  'flash-sales',
  'day-close-history',
] as const;
export type ReportExportKind = (typeof reportExportKinds)[number];
export interface ReportExportFilters {
  kind: ReportExportKind;
  from: string;
  to: string;
  storeIds: readonly string[];
  /** Legacy "report name". */
  label?: string;
  /** Legacy "report message". */
  note?: string;
  source?: 'store' | 'online';
  dateType?: 'order_date' | 'return_date';
  attempts?: 'all' | 'latest';
}
/** Returned orders, order transactions and hyperlocal daily filter on local date-times. */
export const timestampExport = (kind: ReportExportKind) =>
  kind === 'returned-orders' || kind === 'order-transactions' || kind === 'hyperlocal-daily';

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/),
  localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  storeIds = z.array(z.string().regex(/^[1-9]\d*$/)).max(500),
  labels = { label: z.string().max(255).optional(), note: z.string().max(255).optional() },
  timestampRange = { from: localDateTime, to: localDateTime, storeIds, ...labels },
  dateRange = { from: localDate, to: localDate, storeIds, ...labels };
export const exportInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('returned-orders'), ...timestampRange }).strict(),
  z
    .object({
      kind: z.literal('order-transactions'),
      ...timestampRange,
      source: z.enum(['store', 'online']),
      dateType: z.enum(['order_date', 'return_date']),
    })
    .strict(),
  z.object({ kind: z.literal('hyperlocal-daily'), ...timestampRange }).strict(),
  z.object({ kind: z.literal('cash-balance'), ...dateRange }).strict(),
  z.object({ kind: z.literal('flash-sales'), ...dateRange }).strict(),
  z
    .object({
      kind: z.literal('day-close-history'),
      ...dateRange,
      attempts: z.enum(['all', 'latest']),
    })
    .strict(),
]);
export type ReportExportInput = z.infer<typeof exportInputSchema>;
const queuedSchema = z.object({ message: z.string() });

/** Build the strict legacy export input carrying only the filters its task receives. */
export function reportExportInput(filters: ReportExportFilters): ReportExportInput {
  const label = filters.label?.trim(),
    note = filters.note?.trim(),
    common = {
      from: filters.from,
      to: filters.to,
      storeIds: [...new Set(filters.storeIds)],
      ...(label ? { label } : {}),
      ...(note ? { note } : {}),
    };
  return exportInputSchema.parse(
    filters.kind === 'order-transactions'
      ? {
          kind: filters.kind,
          ...common,
          source: filters.source || 'store',
          dateType: filters.dateType || 'order_date',
        }
      : filters.kind === 'day-close-history'
        ? { kind: filters.kind, ...common, attempts: filters.attempts || 'all' }
        : { kind: filters.kind, ...common },
  );
}
/** Legacy `handle_export`: queue the export task and return its message; the file appears later. */
export async function queueReportExport(ownerId: string, filters: ReportExportFilters) {
  const input = reportExportInput(filters);
  return request(
    '/api/v1/report-exports',
    { method: 'POST', operatorId: ownerId, body: JSON.stringify({ input }) },
    queuedSchema,
  );
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
/** The administration list export was a rewrite-only feature and has been removed. */
export function queueAdministrationCollectionExport(
  _ownerId: string,
  _filters: AdministrationCollectionExportFilters,
): Promise<ReportExportRow> {
  return Promise.reject(new Error('Administration list exports are not available.'));
}
