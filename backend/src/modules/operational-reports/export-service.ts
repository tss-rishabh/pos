import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { asc, count, desc, eq, inArray, like, or, sql, and } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import { generatedId } from '../../db/generated-id.js';
import { PosUser, ReportExport, UserStore } from '../../db/legacy-schema.js';
import { requireStore, type Principal, type Role } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { JobArgs, JobProducer } from '../../jobs/contract.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { localTimestamp } from '../fulfillment/domain.js';
import { closeHistoryService, dayCloseCsv } from '../finance/history.js';
import { cashLedgerService, ledgerBounds } from '../finance/ledger.js';
import {
  cashBalanceCsv,
  exportMessage,
  legacyExports,
  legacyTimePeriod,
  normalizedExportInput,
  requiresSelectedExportStores,
  type ExportStatus,
  type ReportExportInput,
  type ReportExportKind,
} from './export-domain.js';
import type { ReportExportOptions, ReportExportStore } from './export-storage.js';
import {
  returnedOrdersReportService,
  returnedOrdersCsv,
  returnedOrdersInputSchema,
} from './returned-orders.js';
import { orderReportScope } from './report-inputs.js';
import {
  orderTransactionsReportService,
  orderTransactionsInputSchema,
} from './order-transactions.js';
import { orderReportCsv } from './order-report-domain.js';
import { flashSalesReportService, flashSalesInputSchema, flashSalesCsv } from './flash-sales.js';
import {
  hyperlocalDailyReportService,
  hyperlocalDailyInputSchema,
  hyperlocalDailyCsv,
} from './hyperlocal-daily.js';

export interface ExportArtifact {
  bytes: Buffer;
  /** Data rows, as `create_and_upload_csv` counts them (`len(rows)`, helpers/helpers.py:2149). */
  rowCount: number;
}
export type ExportBuilder = (user: Principal, input: ReportExportInput) => Promise<ExportArtifact>;
interface ExportReportServices {
  history?: Pick<ReturnType<typeof closeHistoryService>, 'read'>;
  ledger?: Pick<ReturnType<typeof cashLedgerService>, 'read'>;
  returnedOrders?: Pick<ReturnType<typeof returnedOrdersReportService>, 'read'>;
  orderTransactions?: Pick<ReturnType<typeof orderTransactionsReportService>, 'read'>;
  hyperlocalDaily?: Pick<ReturnType<typeof hyperlocalDailyReportService>, 'read'>;
  flashSales?: Pick<ReturnType<typeof flashSalesReportService>, 'read'>;
}
/** Runs the same report reads the screens use and renders the legacy export columns. */
export function reportExportBuilder(
  config: Config,
  db: Databases,
  services: ExportReportServices = {},
): ExportBuilder {
  const history = services.history || closeHistoryService(config, db),
    ledger = services.ledger || cashLedgerService(config, db),
    returns = services.returnedOrders || returnedOrdersReportService(config, db),
    transactions = services.orderTransactions || orderTransactionsReportService(config, db),
    daily = services.hyperlocalDaily || hyperlocalDailyReportService(config, db),
    flash = services.flashSales || flashSalesReportService(config, db);
  const artifact = (csv: string, rowCount: number): ExportArtifact => ({
    bytes: Buffer.from(csv, 'utf8'),
    rowCount,
  });
  return async (user, input) => {
    if (input.kind === 'day-close-history') {
      const report = await history.read(
        user,
        {
          storeIds: input.storeIds,
          from: input.from,
          to: input.to,
          attempts: input.attempts,
          page: 1,
          pageSize: 500,
        },
        true,
      );
      return artifact(dayCloseCsv(report.data), report.data.length);
    }
    if (input.kind === 'returned-orders') {
      // return_orders_datatable.py:106 orders the file by ro.id desc.
      const report = await returns.read(
        user,
        returnedOrdersInputSchema.parse({
          from: input.from,
          to: input.to,
          storeIds: input.storeIds,
          sort: 'return_id',
          direction: 'desc',
        }),
        true,
      );
      return artifact(returnedOrdersCsv(report.data), report.data.length);
    }
    if (input.kind === 'order-transactions') {
      const report = await transactions.read(
        user,
        orderTransactionsInputSchema.parse({
          from: input.from,
          to: input.to,
          storeIds: input.storeIds,
          source: input.source,
          dateType: input.dateType,
        }),
        true,
      );
      return artifact(orderReportCsv(report.data), report.data.length);
    }
    if (input.kind === 'hyperlocal-daily') {
      const report = await daily.read(
        user,
        hyperlocalDailyInputSchema.parse({
          from: input.from,
          to: input.to,
          storeIds: input.storeIds,
        }),
        true,
      );
      return artifact(hyperlocalDailyCsv(report.data), report.data.length);
    }
    if (input.kind === 'flash-sales') {
      const report = await flash.read(
        user,
        flashSalesInputSchema.parse({ from: input.from, to: input.to, storeIds: input.storeIds }),
        true,
      );
      return artifact(flashSalesCsv(report.data), report.data.length);
    }
    const report = await ledger.read(user, input.storeIds, input.from, input.to);
    return artifact(cashBalanceCsv(report.data), report.data.length);
  };
}
const noAccess = () =>
  new AppError(403, 'EXPORT_ACCESS_DENIED', 'You do not have permission to access this export.');
/** Writer-current principal: account, role, user type and store assignments. */
async function currentOperator(tx: AdministrationTransaction, id: string): Promise<Principal> {
  const [row] = await tx
    .select({
      id: PosUser.id,
      role: PosUser.role,
      active: PosUser.is_active,
      userType: PosUser.user_type,
    })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(id)))
    .limit(1);
  if (
    !row?.active ||
    ![1, 2, 3, 4, 5].includes(row.role) ||
    (row.userType !== 1 && row.userType !== 2)
  )
    throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  const assignments = await tx
    .select({ storeId: UserStore.store_id })
    .from(UserStore)
    .where(eq(UserStore.django_user_id, row.id));
  return {
    id,
    name: '',
    email: '',
    role: row.role as Role,
    userType: row.userType,
    storeIds: [
      ...new Set(
        assignments.flatMap((value) => (value.storeId === null ? [] : [String(value.storeId)])),
      ),
    ],
  };
}
const internalSuperadmin = (user: Principal) => user.role === 1 && user.userType === 1;
/** Legacy job arguments (ids and scalar filters only, as the Celery `request_data` dicts). */
const jobArgsSchema = z
  .object({
    user_id: identifier,
    report_name: z.string().max(255),
    report_message: z.string().max(255),
    date_from: z.string().max(32),
    date_to: z.string().max(32),
    store_ids: z.array(identifier).max(500),
    date_type: z.enum(['order_date', 'return_date']).optional(),
    order_source: z.enum(['store_orders', 'online_orders']).optional(),
    attempts: z.enum(['all', 'latest']).optional(),
  })
  .strict();
export type ReportExportJobArgs = z.infer<typeof jobArgsSchema>;
export function exportJobArgs(userId: string, input: ReportExportInput): JobArgs {
  return {
    user_id: userId,
    report_name: input.label ?? '',
    report_message: input.note ?? '',
    date_from: input.from,
    date_to: input.to,
    store_ids: input.storeIds,
    ...(input.kind === 'order-transactions'
      ? {
          date_type: input.dateType,
          order_source: input.source === 'online' ? 'online_orders' : 'store_orders',
        }
      : {}),
    ...(input.kind === 'day-close-history' ? { attempts: input.attempts } : {}),
  };
}
export function exportInputFromJobArgs(kind: ReportExportKind, value: unknown) {
  const args = jobArgsSchema.parse(value);
  return {
    userId: args.user_id,
    input: normalizedExportInput({
      kind,
      from: args.date_from,
      to: args.date_to,
      storeIds: args.store_ids,
      label: args.report_name,
      note: args.report_message,
      ...(kind === 'order-transactions'
        ? {
            dateType: args.date_type ?? 'order_date',
            source: args.order_source === 'online_orders' ? 'online' : 'store',
          }
        : {}),
      ...(kind === 'day-close-history' ? { attempts: args.attempts ?? 'all' } : {}),
    }),
  };
}
export const exportListInputSchema = z
  .object({
    search: z.string().trim().max(100).default(''),
    sort: z
      .enum([
        'id',
        'report_name',
        'report_type',
        'time_period',
        'export_status',
        'message',
        'export_requested_by',
        'export_requested_at',
        'export_completed_at',
        'export_format',
        'export_size',
        'export_rows_count',
        'created_at',
      ])
      .default('id'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(25),
  })
  .strict();
export type ExportListInput = z.infer<typeof exportListInputSchema>;
export interface ReportExportListRow {
  id: string;
  kind: string;
  reportName: string;
  note: string;
  period: string | null;
  status: ExportStatus;
  exportStatus: string | null;
  message: string;
  requestedBy: string;
  requestedByName: string;
  requestedAt: string | null;
  completedAt: string | null;
  format: string;
  sizeKb: number;
  rowCount: number;
  canDownload: boolean;
}
export function reportExportService(
  config: Config,
  db: Databases,
  options: ReportExportOptions,
  store: ReportExportStore | undefined,
  jobs: JobProducer,
  builder: ExportBuilder = reportExportBuilder(config, db),
  clock = () => Temporal.Now.instant(),
  ledger: Pick<ReturnType<typeof cashLedgerService>, 'stores'> = cashLedgerService(config, db),
) {
  const transaction = <T>(operation: (tx: AdministrationTransaction) => Promise<T>) =>
    retryTransaction(() => db.get('writer').transaction(operation));
  const requireStorage = () => {
    if (!store)
      throw new AppError(
        503,
        'REPORT_STORAGE_UNAVAILABLE',
        'Configure private report storage before requesting exports.',
      );
    return store;
  };
  const now = () => localTimestamp(clock(), config.BUSINESS_TIMEZONE);
  const fileAllowed = (
    user: Principal,
    row: { complete: boolean | null; format: string; file: string; requestedBy: number },
  ) =>
    (internalSuperadmin(user) || String(row.requestedBy) === user.id) &&
    row.complete === true &&
    /^(csv|xlsx)$/i.test(row.format) &&
    row.file.toLowerCase().endsWith('.' + row.format.toLowerCase()) &&
    !/^https?:/i.test(row.file) &&
    row.file.startsWith(options.S3_REPORT_EXPORT_FOLDER_PATH + '/') &&
    !/[\p{C}\\]/u.test(row.file) &&
    !row.file.split('/').some((part) => part === '.' || part === '..');
  return {
    /**
     * Legacy `handle_export`: validate, enqueue the task with its filters and requester, and
     * answer at once. The task itself creates the report_exports row.
     */
    async create(user: Principal, value: unknown): Promise<{ message: string }> {
      requireStorage();
      const input = normalizedExportInput(value),
        spec = legacyExports[input.kind],
        current = await transaction((tx) => currentOperator(tx, user.id));
      input.storeIds.forEach((id) => requireStore(current, id));
      if (
        requiresSelectedExportStores(input.kind) ||
        (input.kind === 'hyperlocal-daily' && current.userType === 2)
      )
        orderReportScope(current, input.storeIds);
      let queued = input;
      if (input.kind === 'cash-balance') {
        // cash_balance_datatable.py:44-66: selected ∩ visible (or all visible), dates clamped.
        const bounds = ledgerBounds(input.from, input.to, clock(), config.BUSINESS_TIMEZONE),
          visible = (await ledger.stores(current)).data.map((row) => row.id),
          stores = input.storeIds.length
            ? input.storeIds.filter((id) => visible.includes(id))
            : visible;
        if (!stores.length)
          throw new AppError(400, 'EXPORT_STORES_REQUIRED', 'Pick at least one store to export.');
        queued = { ...input, from: bounds.from, to: bounds.to, storeIds: stores };
      }
      await jobs.enqueue(spec.job, exportJobArgs(current.id, queued), { queue: spec.queue });
      return { message: spec.message };
    },
    /**
     * The export task body (E1-E6): create the row as `Processing`, build and upload the CSV,
     * then complete it. E3/E5/E6 record `FAILED`; E1/E2/E4 have no failure branch in legacy, so
     * their row stays `Processing` when the task dies.
     */
    async run(kind: ReportExportKind, args: unknown): Promise<string> {
      const { userId, input } = exportInputFromJobArgs(kind, args),
        spec = legacyExports[kind],
        requestedAt = now(),
        fields = {
          report_name: input.label || spec.defaultName,
          report_type: spec.reportType,
          time_period: legacyTimePeriod(input),
          message: input.note || '',
          export_requested_by: Number(userId),
          export_requested_at: requestedAt,
        };
      const exportId = generatedId(
        await db
          .get('writer')
          .insert(ReportExport)
          .values({
            ...fields,
            is_completed: false,
            export_status: 'Processing',
            export_completed_at: null,
            export_file_url: '',
            export_format: 'CSV',
            export_size: 0,
            export_rows_count: 0,
            created_at: requestedAt,
            updated_at: requestedAt,
          }),
      );
      try {
        const storage = requireStorage(),
          principal = await transaction((tx) => currentOperator(tx, userId)),
          artifact = await builder(principal, input);
        if (artifact.bytes.length > options.REPORT_EXPORT_MAX_BYTES)
          throw new AppError(422, 'EXPORT_TOO_LARGE', 'Select a smaller store/date range.');
        const key = storage.keyFor(spec.folder);
        await storage.put(
          key,
          artifact.bytes,
          createHash('sha256').update(artifact.bytes).digest('hex'),
        );
        const completedAt = now();
        await db
          .get('writer')
          .update(ReportExport)
          .set({
            ...fields,
            is_completed: true,
            export_status: spec.completedStatus,
            export_file_url: key,
            export_format: 'CSV',
            // file_size / 1024 stored in an IntegerField: Django's int() truncates.
            export_size: Math.trunc(artifact.bytes.length / 1024),
            export_rows_count: artifact.rowCount,
            export_completed_at: completedAt,
            updated_at: completedAt,
          })
          .where(eq(ReportExport.id, exportId));
      } catch (error) {
        if (spec.failureBranch) {
          const failedAt = now();
          await db
            .get('writer')
            .update(ReportExport)
            .set({
              ...fields,
              is_completed: false,
              export_status: 'FAILED',
              export_file_url: '',
              export_format: 'CSV',
              export_size: 0,
              export_rows_count: 0,
              export_completed_at: failedAt,
              updated_at: failedAt,
            })
            .where(eq(ReportExport.id, exportId));
        }
        throw error;
      }
      return String(exportId);
    },
    /**
     * Legacy `AjaxExportLogsView` (export_datatable.py:23-101) over report_exports. Security:
     * non-superadmins see only their own requests (legacy lists every row to every user).
     */
    async list(user: Principal, value: unknown) {
      const input = exportListInputSchema.parse(value),
        current = await transaction((tx) => currentOperator(tx, user.id)),
        primary = db.get('primary'),
        pattern = '%' + input.search.replace(/[\\%_]/g, (match) => '\\' + match) + '%',
        scope = and(
          internalSuperadmin(current)
            ? undefined
            : eq(ReportExport.export_requested_by, Number(current.id)),
          input.search
            ? or(
                like(ReportExport.report_name, pattern),
                like(ReportExport.report_type, pattern),
                like(ReportExport.message, pattern),
                sql`cast(${ReportExport.created_at} as char) like ${pattern}`,
              )
            : undefined,
        ),
        column = ReportExport[input.sort],
        [totals, rows] = await Promise.all([
          primary.select({ total: count() }).from(ReportExport).where(scope),
          primary
            .select()
            .from(ReportExport)
            .where(scope)
            .orderBy(input.direction === 'asc' ? asc(column) : desc(column), desc(ReportExport.id))
            .limit(input.pageSize)
            .offset((input.page - 1) * input.pageSize),
        ]),
        ids = [...new Set(rows.map((row) => BigInt(row.export_requested_by)))],
        names = ids.length
          ? await primary
              .select({ id: PosUser.id, name: PosUser.username })
              .from(PosUser)
              .where(inArray(PosUser.id, ids))
          : [],
        named = new Map(names.map((row) => [String(row.id), row.name]));
      const instant = (value: string | null) =>
        value && !value.startsWith('0000-00-00')
          ? Temporal.PlainDateTime.from(value.replace(' ', 'T'))
              .toZonedDateTime(config.BUSINESS_TIMEZONE)
              .toInstant()
              .toString()
          : null;
      const data: ReportExportListRow[] = rows.map((row) => {
        const status: ExportStatus = row.is_completed
          ? 'COMPLETED'
          : ['FAILED', 'ERROR'].includes((row.export_status ?? '').toUpperCase())
            ? 'FAILED'
            : 'QUEUED';
        return {
          id: String(row.id),
          kind: row.report_type,
          reportName: row.report_name,
          note: row.message,
          period: row.time_period,
          status,
          exportStatus: row.export_status,
          message: exportMessage(status),
          requestedBy: String(row.export_requested_by),
          requestedByName:
            named.get(String(row.export_requested_by)) || String(row.export_requested_by),
          requestedAt: instant(row.export_requested_at),
          completedAt: instant(row.export_completed_at),
          format: row.export_format,
          sizeKb: row.export_size,
          rowCount: row.export_rows_count,
          canDownload: fileAllowed(current, {
            complete: row.is_completed,
            format: row.export_format,
            file: row.export_file_url,
            requestedBy: row.export_requested_by,
          }),
        };
      });
      return {
        data,
        total: totals[0]?.total || 0,
        page: input.page,
        pageSize: input.pageSize,
      };
    },
    /** Authenticated stream instead of the legacy presigned URL. */
    async download(user: Principal, id: string, signal?: AbortSignal) {
      const row = await transaction(async (tx) => {
        const current = await currentOperator(tx, user.id),
          [row] = await tx
            .select()
            .from(ReportExport)
            .where(eq(ReportExport.id, BigInt(id)))
            .limit(1);
        if (!row) throw new AppError(404, 'EXPORT_NOT_FOUND', 'Export not found.');
        if (!internalSuperadmin(current) && String(row.export_requested_by) !== current.id)
          throw noAccess();
        if (
          !fileAllowed(current, {
            complete: row.is_completed,
            format: row.export_format,
            file: row.export_file_url,
            requestedBy: row.export_requested_by,
          })
        )
          throw new AppError(409, 'EXPORT_NOT_READY', 'This export is not ready to download.');
        return row;
      });
      const xlsx = row.export_format.toUpperCase() === 'XLSX',
        file = await requireStorage().stream(row.export_file_url, undefined, signal);
      return {
        ...file,
        filename: `report-${id}.${xlsx ? 'xlsx' : 'csv'}`,
        contentType: xlsx
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8',
      };
    },
  };
}
export type ReportExportService = ReturnType<typeof reportExportService>;
