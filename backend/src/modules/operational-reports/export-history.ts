import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import { exportMessage, exportStatus, type ExportStatus } from './export-domain.js';
import { scalarId, warehouseView, warehouseReportCount } from './report-inputs.js';
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDate.from(value).year >= 1000;
    } catch {
      return false;
    }
  }, 'Use a valid calendar date.');
export const exportHistoryInputSchema = z
  .object({
    origin: z.enum(['current', 'legacy']).default('current'),
    period: z.enum(['recent', 'archive']).default('recent'),
    from: day.optional(),
    to: day.optional(),
    search: z.string().trim().max(100).default(''),
    sort: z
      .enum([
        'id',
        'kind',
        'period',
        'message',
        'format',
        'requested_at',
        'completed_at',
        'report_name',
        'status',
        'requested_by',
        'row_count',
        'byte_count',
      ])
      .default('requested_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(25),
  })
  .strict();
export type ExportHistoryInput = z.infer<typeof exportHistoryInputSchema>;
export interface ReportExportListRow {
  id: string;
  origin: 'current' | 'legacy';
  kind: string;
  reportName: string;
  note: string | null;
  from: string | null;
  to: string | null;
  status: ExportStatus;
  message: string;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string | null;
  completedAt: string | null;
  format: string;
  byteCount: number | null;
  rowCount: number | null;
  canDownload: boolean;
  period?: string | null;
}
export function exportHistoryOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({ BQ_REPORT_EXPORTS_VIEW: warehouseView, BQ_LEGACY_REPORT_EXPORTS_VIEW: warehouseView })
    .parse(env);
}
function databaseTime(value: Temporal.Instant, zone: string) {
  return value
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'millisecond' })
    .replace('T', ' ');
}
export function exportHistoryBounds(
  config: Pick<Config, 'BUSINESS_TIMEZONE'>,
  input: ExportHistoryInput,
  now: Temporal.Instant,
) {
  const today = now.toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate(),
    from = Temporal.PlainDate.from(input.from || today.subtract({ days: 30 }).toString()),
    to = Temporal.PlainDate.from(input.to || today.toString()),
    span = to.since(from, { largestUnit: 'days' }).days;
  if (span < 0 || span > 366)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'Select an archive range of 366 days or less.');
  const cutoff = now.subtract({ hours: 24 }),
    start = from.toZonedDateTime({ timeZone: config.BUSINESS_TIMEZONE }).toInstant(),
    requestedEnd = to
      .add({ days: 1 })
      .toZonedDateTime({ timeZone: config.BUSINESS_TIMEZONE })
      .toInstant(),
    end = Temporal.Instant.compare(requestedEnd, cutoff) < 0 ? requestedEnd : cutoff,
    zone = input.origin === 'current' ? 'UTC' : config.BUSINESS_TIMEZONE;
  return {
    cutoff: databaseTime(cutoff, zone),
    start: databaseTime(start, zone),
    end: databaseTime(end, zone),
    empty: Temporal.Instant.compare(start, end) >= 0,
    zone,
  };
}
const timestamp = z.string().nullable(),
  rowSchema = z.object({
    id: z.string(),
    kind: z.string().max(255),
    reportName: z.string().max(255),
    note: z.string().max(255).nullable(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    status: exportStatus,
    requestedBy: scalarId,
    requestedAt: timestamp,
    completedAt: timestamp,
    format: z.string().max(10),
    byteCount: z.coerce.number().int().nonnegative().nullable(),
    rowCount: z.coerce.number().int().nonnegative().nullable(),
    period: z.string().max(255).nullable().optional(),
  });
/** Archive projection is metadata only; no storage key, filters, token or raw error message. */
export function exportHistoryReader(
  config: Config,
  options: ReturnType<typeof exportHistoryOptions> = exportHistoryOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async list(
      user: Principal,
      value: ExportHistoryInput,
    ): Promise<{ data: ReportExportListRow[]; total: number; page: number; pageSize: number }> {
      const input = exportHistoryInputSchema.parse(value),
        bounds = exportHistoryBounds(config, input, clock());
      if (input.period !== 'archive')
        throw new AppError(400, 'ARCHIVE_PERIOD_REQUIRED', 'Choose archived export history.');
      if (bounds.empty) return { data: [], total: 0, page: 1, pageSize: input.pageSize };
      const view =
        input.origin === 'current'
          ? options.BQ_REPORT_EXPORTS_VIEW
          : options.BQ_LEGACY_REPORT_EXPORTS_VIEW;
      if (!view) return unavailable('BigQuery report export history view');
      const params = {
          start: bounds.start,
          end: bounds.end,
          cutoff: bounds.cutoff,
          allOwners: user.role === 1 && user.userType === 1,
          owner: user.id,
          search: input.search.toLowerCase(),
        },
        types = {
          start: 'DATETIME',
          end: 'DATETIME',
          cutoff: 'DATETIME',
          allOwners: 'BOOL',
          owner: 'STRING',
          search: 'STRING',
        },
        where =
          "status IN ('COMPLETED','FAILED') AND terminal_at>=@start AND terminal_at<@end AND terminal_at<@cutoff AND (@allOwners OR CAST(operator_id AS STRING)=@owner) AND (@search='' OR EXISTS (SELECT 1 FROM UNNEST([report_name,kind,note,status]) AS cell WHERE STRPOS(LOWER(COALESCE(cell,'')),@search)>0))",
        table = '`' + view + '`';
      const counted = await warehouse.queryReport(
          `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
          params,
          types,
          'report-export-history',
        ),
        total = warehouseReportCount(counted),
        page = input.page <= Math.ceil(total / input.pageSize) ? input.page : 1;
      if (!total) return { data: [], total, page, pageSize: input.pageSize };
      const sort = {
          id: input.origin === 'legacy' ? 'CAST(id AS INT64)' : 'id',
          kind: 'kind',
          period:
            input.origin === 'legacy'
              ? 'time_period'
              : "CONCAT(COALESCE(CAST(period_start AS STRING),''),' – ',COALESCE(CAST(period_end AS STRING),''))",
          message:
            "CASE status WHEN 'QUEUED' THEN 'Waiting to prepare the report.' WHEN 'BUILDING' THEN 'Preparing the report.' WHEN 'STORING' THEN 'Verifying the report file.' WHEN 'COMPLETED' THEN 'Report file is ready.' ELSE 'The export could not be completed. Request a new export.' END",
          format: 'format',
          requested_at: 'requested_at',
          completed_at: 'completed_at',
          report_name: 'report_name',
          status: 'status',
          requested_by: 'CAST(operator_id AS INT64)',
          row_count: 'row_count',
          byte_count: 'byte_count',
        }[input.sort],
        rows = await warehouse.queryReport(
          `SELECT CAST(id AS STRING) AS id,kind,report_name AS reportName,note,period_start AS \`from\`,period_end AS \`to\`,${input.origin === 'legacy' ? 'time_period' : 'CAST(NULL AS STRING)'} AS period,status,CAST(operator_id AS STRING) AS requestedBy,requested_at AS requestedAt,completed_at AS completedAt,format,byte_count AS byteCount,row_count AS rowCount FROM ${table} WHERE ${where} ORDER BY ${sort} ${input.direction},id DESC LIMIT @limit OFFSET @offset`,
          { ...params, limit: input.pageSize, offset: (page - 1) * input.pageSize },
          { ...types, limit: 'INT64', offset: 'INT64' },
          'report-export-history',
        ),
        parsed = z.array(rowSchema).safeParse(rows);
      if (!parsed.success)
        throw new AppError(
          503,
          'EXPORT_HISTORY_VIEW_INVALID',
          'Archived export metadata does not match the required data contract.',
        );
      const asInstant = (value: string | null) => {
        if (!value || value.startsWith('0000-00-00')) return null;
        try {
          return Temporal.PlainDateTime.from(value.replace(' ', 'T'))
            .toZonedDateTime(bounds.zone)
            .toInstant()
            .toString();
        } catch {
          throw new AppError(
            503,
            'EXPORT_HISTORY_VIEW_INVALID',
            'Archived export metadata does not match the required data contract.',
          );
        }
      };
      const data = parsed.data.map((row) => {
        if (
          (!(user.role === 1 && user.userType === 1) && row.requestedBy !== user.id) ||
          (input.origin === 'current' && !z.uuid().safeParse(row.id).success) ||
          (input.origin === 'legacy' && (!/^\d+$/.test(row.id) || row.period === undefined))
        )
          throw new AppError(
            503,
            'EXPORT_HISTORY_VIEW_INVALID',
            'Archived export metadata does not match the required data contract.',
          );
        return {
          ...row,
          note: input.origin === 'legacy' ? null : row.note,
          origin: input.origin,
          requestedAt: asInstant(row.requestedAt),
          completedAt: asInstant(row.completedAt),
          message: exportMessage(row.status),
          canDownload: false,
        };
      });
      return { data, total, page, pageSize: input.pageSize };
    },
  };
}
