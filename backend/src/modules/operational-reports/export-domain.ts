import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import type { CashLedgerRow } from '../finance/ledger.js';
import type { JobName, JobQueue } from '../../jobs/contract.js';
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
/** Legacy `report_name` / `report_message` POST fields, stored on the report_exports row. */
const labels = {
  label: z
    .string()
    .trim()
    .max(255)
    .refine((value) => !/[\p{C}]/u.test(value), 'Use a report name without control characters.')
    .optional(),
  note: z.string().trim().max(255).optional(),
};
const storeIds = z.array(identifier).max(500).default([]);
const timestampRange = { from: businessTimestamp, to: businessTimestamp, storeIds, ...labels };
const dateRange = { from: date, to: date, storeIds, ...labels };
/**
 * The six legacy export actions (phase-c-legacy-jobs.md §2.6, E1-E6). Each input carries only the
 * filters the legacy view passed to its Celery task.
 */
export const exportInputSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('returned-orders'), ...timestampRange }).strict(),
    z
      .object({
        kind: z.literal('order-transactions'),
        ...timestampRange,
        source: z.enum(['store', 'online']).default('store'),
        dateType: z.enum(['order_date', 'return_date']).default('order_date'),
      })
      .strict(),
    z.object({ kind: z.literal('cash-balance'), ...dateRange }).strict(),
    z.object({ kind: z.literal('flash-sales'), ...dateRange }).strict(),
    z
      .object({
        kind: z.literal('day-close-history'),
        ...dateRange,
        attempts: z.enum(['all', 'latest']).default('all'),
      })
      .strict(),
    z.object({ kind: z.literal('hyperlocal-daily'), ...timestampRange }).strict(),
  ])
  .superRefine((input, ctx) => {
    if (timestampExportKind(input.kind)) {
      try {
        const span = Temporal.PlainDateTime.from(input.to)
          .since(Temporal.PlainDateTime.from(input.from), { largestUnit: 'days' })
          .total('seconds');
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
export type ReportExportKind = ReportExportInput['kind'];
export function timestampExportKind(kind: string) {
  return ['returned-orders', 'order-transactions', 'hyperlocal-daily'].includes(kind);
}
export function requiresSelectedExportStores(kind: ReportExportKind) {
  return kind === 'returned-orders' || kind === 'order-transactions' || kind === 'flash-sales';
}
export function normalizedExportInput(value: unknown): ReportExportInput {
  const input = exportInputSchema.parse(value);
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
/**
 * Per-export legacy facts: task name and queue, `report_exports.report_type`, upload folder
 * (`uploads/reports/{folder}/orders_{uuid}.csv`), default report name, completed-status casing
 * and whether the task has a failure branch that writes `FAILED`.
 */
export interface LegacyExportSpec {
  job: JobName;
  queue: JobQueue;
  reportType: string;
  folder: string;
  defaultName: string;
  completedStatus: 'COMPLETED' | 'Completed';
  failureBranch: boolean;
  /** Legacy HTTP response message (`handle_export`). */
  message: string;
}
const queuedMessage =
  'Records are being exported to CSV. The file will be available in the Export tab shortly. Click here to open the Export tab.';
export const legacyExports: Record<ReportExportKind, LegacyExportSpec> = {
  // report/datatables/return_orders_datatable.py:36,79-86,131-156
  'returned-orders': {
    job: 'report.datatables.return_orders_datatable.do_return_export',
    queue: 'export_queue',
    reportType: 'RETURN',
    folder: 'returns',
    defaultName: '',
    completedStatus: 'COMPLETED',
    failureBranch: false,
    message: queuedMessage,
  },
  // report/datatables/return_orders_datatable.py:298,345-352,485-508
  'order-transactions': {
    job: 'report.datatables.return_orders_datatable.do_order_export',
    queue: 'export_queue',
    reportType: 'ORDER',
    folder: 'orders',
    defaultName: '',
    completedStatus: 'COMPLETED',
    failureBranch: false,
    message: queuedMessage,
  },
  // report/datatables/cash_balance_datatable.py:68-135
  'cash-balance': {
    job: 'report.datatables.cash_balance_datatable.do_cash_balance_export',
    queue: 'export_queue',
    reportType: 'CASH_BALANCE',
    folder: 'cash_balance',
    defaultName: 'Cash balance',
    completedStatus: 'Completed',
    failureBranch: true,
    message:
      'Cash balance is being exported to CSV. The file will be available in the Export tab shortly. Click here to open the Export tab.',
  },
  // report/datatables/sales_data.py:37,82-89 (report_type RETURN is the legacy label), :120-143
  'flash-sales': {
    job: 'report.datatables.sales_data.do_sales_export',
    queue: 'sales_queue',
    reportType: 'RETURN',
    folder: 'sales',
    defaultName: '',
    completedStatus: 'COMPLETED',
    failureBranch: false,
    message: queuedMessage,
  },
  // report/datatables/day_close_datatable.py:111-125,215-315
  'day-close-history': {
    job: 'report.datatables.day_close_datatable.do_day_close_export',
    queue: 'export_queue',
    reportType: 'DAY_CLOSE',
    folder: 'day_close',
    defaultName: 'Close history',
    completedStatus: 'Completed',
    failureBranch: true,
    message:
      'Close history is being exported to CSV. The file will be available in the Export tab shortly. Click here to open the Export tab.',
  },
  // report/datatables/hyperlocal_daily_datatable.py:30-37,60-67,137-173
  'hyperlocal-daily': {
    job: 'report.datatables.hyperlocal_daily_datatable.do_hyperlocal_daily_export',
    queue: 'export_queue',
    reportType: 'HYPERLOCAL_DAILY',
    folder: 'hyperlocal',
    defaultName: '',
    completedStatus: 'COMPLETED',
    failureBranch: true,
    message:
      'Hyperlocal daily report is being prepared. The file will be available in the Export Logs tab shortly.',
  },
};
/** `report_exports.time_period` exactly as each legacy task formats it. */
export function legacyTimePeriod(input: ReportExportInput): string {
  const stamp = (value: string) =>
    Temporal.PlainDateTime.from(value).toString({ smallestUnit: 'second' }).replace('T', ' ');
  if (timestampExportKind(input.kind)) return `${stamp(input.from)} - ${stamp(input.to)}`;
  // sales_data.py:76-88 parses `%m/%d/%Y` dates and prints them with a midnight time.
  if (input.kind === 'flash-sales') return `${input.from} 00:00:00 - ${input.to} 00:00:00`;
  return `${input.from} - ${input.to}`;
}
export const exportStatus = z.enum(['QUEUED', 'COMPLETED', 'FAILED']);
export type ExportStatus = z.infer<typeof exportStatus>;
export function exportMessage(status: ExportStatus): string {
  return {
    QUEUED: 'Waiting to prepare the report.',
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
    '﻿' +
    [
      ledgerColumns.map(([, label]) => label),
      ...rows.map((row) => ledgerColumns.map(([field]) => row[field])),
    ]
      .map((row) => row.map(reportCsvCell).join(','))
      .join('\r\n')
  );
}
