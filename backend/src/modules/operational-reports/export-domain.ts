import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import type { CashLedgerRow } from '../finance/ledger.js';
import { businessTimestamp } from './report-inputs.js';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDate.from(value).year >= 1000;
    } catch {
      return false;
    }
  }, 'Use a valid calendar date.');
const labels = {
  label: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !/[\p{C}]/u.test(value), 'Use a report name without control characters.')
    .optional(),
  note: z.string().trim().max(255).optional(),
};
const common = {
  from: date,
  to: date,
  storeIds: z.array(identifier).max(500).default([]),
  ...labels,
};
export const exportInputSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('current-inventory-workbook'),
        ...labels,
        storeIds: z
          .array(identifier)
          .min(1)
          .max(500)
          .refine(
            (ids) => new Set(ids).size === ids.length,
            'Select each store once. [duplicate store]',
          ),
      })
      .strict(),
    z
      .object({
        kind: z.literal('day-close-history'),
        ...common,
        attempts: z.enum(['all', 'latest']).default('all'),
        search: z.string().trim().max(100).default(''),
      })
      .strict(),
    z.object({ kind: z.literal('cash-balance'), ...common }).strict(),
    z.object({ kind: z.literal('flash-sales'), ...common }).strict(),
    z
      .object({
        kind: z.literal('returned-orders'),
        ...labels,
        from: businessTimestamp,
        to: businessTimestamp,
        storeIds: common.storeIds,
        search: z.string().trim().max(100).default(''),
      })
      .strict(),
    z
      .object({
        kind: z.literal('order-transactions'),
        ...labels,
        from: businessTimestamp,
        to: businessTimestamp,
        storeIds: common.storeIds,
        source: z.enum(['store', 'online']).default('store'),
        dateType: z.enum(['order_date', 'return_date']).default('order_date'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('hyperlocal-daily'),
        ...labels,
        from: businessTimestamp,
        to: businessTimestamp,
        storeIds: common.storeIds,
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if (input.kind === 'current-inventory-workbook') return;
    if (timestampExportKind(input.kind)) {
      try {
        const start = Temporal.PlainDateTime.from(input.from),
          end = Temporal.PlainDateTime.from(input.to),
          span = end.since(start, { largestUnit: 'days' }).total('seconds');
        if (span < 0 || span > 63 * 86400 - 1)
          ctx.addIssue({
            code: 'custom',
            message: 'Select a valid range of 62 calendar days or less.',
            path: ['to'],
          });
      } catch {}
      return;
    }
    let span: number;
    try {
      span = Temporal.PlainDate.from(input.to).since(Temporal.PlainDate.from(input.from), {
        largestUnit: 'days',
      }).days;
    } catch {
      return;
    }
    if (span < 0 || span > (input.kind === 'flash-sales' ? 62 : 366))
      ctx.addIssue({
        code: 'custom',
        message:
          input.kind === 'flash-sales'
            ? 'Select a valid range of 62 calendar days or less.'
            : 'Select a valid range of 366 days or less.',
        path: ['to'],
      });
  });
export type ReportExportInput = z.infer<typeof exportInputSchema>;
export function timestampExportKind(kind: string) {
  return kind === 'returned-orders' || kind === 'order-transactions' || kind === 'hyperlocal-daily';
}
export function requiresSelectedExportStores(kind: ReportExportInput['kind']) {
  return (
    kind === 'returned-orders' ||
    kind === 'order-transactions' ||
    kind === 'flash-sales' ||
    kind === 'current-inventory-workbook'
  );
}
export const exportStatus = z.enum(['QUEUED', 'BUILDING', 'STORING', 'COMPLETED', 'FAILED']);
export type ExportStatus = z.infer<typeof exportStatus>;
export function normalizedExportInput(value: unknown): ReportExportInput {
  const input = exportInputSchema.parse(value);
  if (input.kind === 'current-inventory-workbook') return input;
  return {
    ...input,
    ...(timestampExportKind(input.kind)
      ? {
          from: Temporal.PlainDateTime.from(input.from).toString({ smallestUnit: 'second' }),
          to: Temporal.PlainDateTime.from(input.to).toString({ smallestUnit: 'second' }),
        }
      : {}),
    storeIds: [...new Set(input.storeIds)].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
    ),
  };
}
export function exportMessage(status: ExportStatus): string {
  return {
    QUEUED: 'Waiting to prepare the report.',
    BUILDING: 'Preparing the report.',
    STORING: 'Verifying the report file.',
    COMPLETED: 'Report file is ready.',
    FAILED: 'The export could not be completed. Request a new export.',
  }[status];
}
/** Keep accounting numbers numeric while preventing untrusted spreadsheet formulas. */
export function reportCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\p{C}\p{Z}\s]*[=+\-@\t\r]/u.test(text) && !/^[-+]?\d+(?:\.\d+)?$/.test(text))
    text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
const ledgerColumns = [
  ['store_name', 'Store Name'],
  ['date', 'Date'],
  ['opening_cash', 'Opening cash'],
  ['sales_cash', "Today's sales cash"],
  ['running_total', "Previous cash balance + today's sale cash"],
  ['actual_cash', 'Actual sale cash'],
  ['difference', 'Difference'],
  ['banking_amount', 'Banking amount'],
  ['closing_balance', 'Closing balance'],
  ['status', 'Status'],
  ['note', 'Note'],
] as const;
export function cashBalanceCsv(rows: CashLedgerRow[]): string {
  return (
    '\uFEFF' +
    [
      ledgerColumns.map(([, label]) => label),
      ...rows.map((row) => ledgerColumns.map(([field]) => row[field])),
    ]
      .map((row) => row.map(reportCsvCell).join(','))
      .join('\r\n')
  );
}
export function validateExportArtifact(bytes: Buffer, rowCount: number, maxBytes: number): void {
  if (
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    rowCount > 70000 ||
    bytes.length > maxBytes
  )
    throw new AppError(422, 'EXPORT_TOO_LARGE', 'Select a smaller store/date range for export.');
}
