import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, count, desc, eq, gte, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import { PosUser, ReportExport, UserStore } from '../../db/legacy-schema.js';
import { Store } from '../../db/legacy-schema.js';
import { requireStore, type Principal, type Role } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { closeHistoryService, dayCloseCsv } from '../finance/history.js';
import { cashLedgerService } from '../finance/ledger.js';
import {
  cashBalanceCsv,
  exportMessage,
  normalizedExportInput,
  type ReportExportInput,
  requiresSelectedExportStores,
} from './export-domain.js';
import { inventoryWorkbookBuilder } from '../inventory-workbooks/index.js';
import {
  administrationCollectionExport,
  assertAdministrationCollectionExport,
  collectionExportScope,
} from '../administration/collection-export.js';
import {
  readInventoryWorkbookOptions,
  type InventoryWorkbookOptions,
} from '../inventory-workbooks/options.js';
import { safeLegacyWorkbookStream } from '../inventory-workbooks/legacy.js';
import { legacyWorkbookUnverified } from '../inventory-workbooks/zip-validation.js';
import { workbookFailureCode, workbookFailureMessage } from '../inventory-workbooks/errors.js';
import {
  prepareExportArtifact,
  type ExportArtifact,
  type ExportBuildContext,
} from './export-artifact.js';
import {
  parsedReportFileFormat,
  reportFileContentType,
  reportFileExtension,
  reportFileFormat,
} from './export-format.js';
import { reportExportJobs, type ReportExportJob } from './export-schema.js';
import type { ReportExportOptions, ReportExportStore } from './export-storage.js';
import {
  returnedOrdersReportService,
  returnedOrdersCsv,
  returnedOrdersInputSchema,
} from './returned-orders.js';
import { orderReportScope } from './report-inputs.js';
import { managerReportExport } from './export-presentation.js';
import { screenReportCsv } from './screen-report-csv.js';
import { acceptanceInputSchema, acceptanceReportService } from './acceptance.js';
import {
  cashierInputSchema,
  salespersonInputSchema,
  staffPerformanceService,
} from './performance.js';
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
import {
  exportHistoryBounds,
  exportHistoryInputSchema,
  exportHistoryReader,
  type ExportHistoryInput,
  type ReportExportListRow,
} from './export-history.js';

export type { ExportArtifact } from './export-artifact.js';
export type ExportBuilder = (
  user: Principal,
  input: ReportExportInput,
  context?: ExportBuildContext,
) => Promise<ExportArtifact>;
interface ExportReportServices {
  history?: Pick<ReturnType<typeof closeHistoryService>, 'read'>;
  ledger?: Pick<ReturnType<typeof cashLedgerService>, 'read'>;
  returnedOrders?: Pick<ReturnType<typeof returnedOrdersReportService>, 'read'>;
  orderTransactions?: Pick<ReturnType<typeof orderTransactionsReportService>, 'read'>;
  hyperlocalDaily?: Pick<ReturnType<typeof hyperlocalDailyReportService>, 'read'>;
  flashSales?: Pick<ReturnType<typeof flashSalesReportService>, 'read'>;
  performance?: Pick<ReturnType<typeof staffPerformanceService>, 'salespeople' | 'cashiers'>;
  acceptance?: Pick<ReturnType<typeof acceptanceReportService>, 'read'>;
  inventoryWorkbook?: ExportBuilder;
  administration?: ReturnType<typeof administrationCollectionExport>;
}
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
    flash = services.flashSales || flashSalesReportService(config, db),
    performance = services.performance || staffPerformanceService(config, db),
    acceptance = services.acceptance || acceptanceReportService(config, db),
    inventory = services.inventoryWorkbook || inventoryWorkbookBuilder(config, db),
    administration = services.administration || administrationCollectionExport(config, db);
  return async (user, input, context) => {
    if (input.kind === 'current-inventory-workbook') return inventory(user, input, context);
    if (input.kind === 'administration-list') return administration(user, input, context);
    if (
      input.kind === 'salesperson-performance' ||
      input.kind === 'cashier-performance' ||
      input.kind === 'hyperlocal-acceptance'
    ) {
      const selection = {
          from: input.from,
          to: input.to,
          storeIds: input.storeIds,
          sort: input.sort,
          direction: input.direction,
        },
        report =
          input.kind === 'salesperson-performance'
            ? await performance.salespeople(user, salespersonInputSchema.parse(selection), true)
            : input.kind === 'cashier-performance'
              ? await performance.cashiers(user, cashierInputSchema.parse(selection), true)
              : await acceptance.read(user, acceptanceInputSchema.parse(selection), true);
      return {
        bytes: Buffer.from(
          screenReportCsv(input.kind, report.data, input.columns, context?.maxBytes),
          'utf8',
        ),
        rowCount: report.data.length,
        format: 'CSV',
      };
    }
    if (input.kind === 'day-close-history') {
      const report = await history.read(user, { ...input, page: 1, pageSize: 500 }, true);
      return {
        bytes: Buffer.from(dayCloseCsv(report.data), 'utf8'),
        rowCount: report.data.length,
        format: 'CSV',
      };
    }
    if (input.kind === 'returned-orders') {
      const report = await returns.read(
        user,
        returnedOrdersInputSchema.parse({
          from: input.from,
          to: input.to,
          storeIds: input.storeIds,
          search: input.search,
          sort: input.sort ?? 'return_id',
          direction: input.direction,
        }),
        true,
      );
      return {
        bytes: Buffer.from(
          input.columns
            ? screenReportCsv(input.kind, report.data, input.columns, context?.maxBytes)
            : returnedOrdersCsv(report.data),
          'utf8',
        ),
        rowCount: report.data.length,
        format: 'CSV',
      };
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
      return {
        bytes: Buffer.from(
          input.columns
            ? screenReportCsv(input.kind, report.data, input.columns, context?.maxBytes)
            : orderReportCsv(report.data),
          'utf8',
        ),
        rowCount: report.data.length,
        format: 'CSV',
      };
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
      return {
        bytes: Buffer.from(hyperlocalDailyCsv(report.data), 'utf8'),
        rowCount: report.data.length,
        format: 'CSV',
      };
    }
    if (input.kind === 'flash-sales') {
      const report = await flash.read(
        user,
        flashSalesInputSchema.parse({
          from: input.from,
          to: input.to,
          storeIds: input.storeIds,
          sort: input.sort,
          direction: input.direction,
        }),
        true,
        input.columns !== undefined,
      );
      return {
        bytes: Buffer.from(
          input.columns
            ? screenReportCsv(input.kind, report.data, input.columns, context?.maxBytes)
            : flashSalesCsv(report.data),
          'utf8',
        ),
        rowCount: report.data.length,
        format: 'CSV',
      };
    }
    const report = await ledger.read(user, input.storeIds, input.from, input.to);
    return {
      bytes: Buffer.from(cashBalanceCsv(report.data), 'utf8'),
      rowCount: report.data.length,
      format: 'CSV',
    };
  };
}
function instant(value: Temporal.Instant) {
  return value
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime()
    .toString({ smallestUnit: 'millisecond' })
    .replace('T', ' ');
}
const noAccess = () =>
  new AppError(403, 'EXPORT_ACCESS_DENIED', 'You no longer have permission to access this export.');
async function currentOperator(
  tx: AdministrationTransaction,
  id: string,
  lock: 'share' | 'update' = 'share',
): Promise<Principal> {
  const [row] = await tx
    .select({
      id: PosUser.id,
      role: PosUser.role,
      active: PosUser.is_active,
      userType: PosUser.user_type,
    })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(id)))
    .limit(1)
    .for(lock);
  if (
    !row?.active ||
    ![1, 2, 3, 4, 5].includes(row.role) ||
    (row.userType !== 1 && row.userType !== 2)
  )
    throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  const assignments = await tx
    .select({ storeId: UserStore.store_id })
    .from(UserStore)
    .where(eq(UserStore.django_user_id, row.id))
    .for('share');
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
function allowed(user: Principal, job: ReportExportJob): boolean {
  return (
    (!managerReportExport(job.input.kind) || user.role === 1) &&
    (user.id === job.operatorId || user.role === 1) &&
    (!job.requiresGlobal || user.role === 1) &&
    (job.requesterUserType === 2 || user.userType === 1) &&
    ((user.role === 1 &&
      !(
        (requiresSelectedExportStores(job.input.kind) ||
          job.input.kind === 'hyperlocal-daily' ||
          managerReportExport(job.input.kind)) &&
        user.userType === 2
      )) ||
      job.storeIds.every((id) => user.storeIds.includes(id)))
  );
}
function assertAllowed(user: Principal, job: ReportExportJob) {
  if (!allowed(user, job)) throw noAccess();
}
async function assertExportKindAuthority(
  tx: AdministrationTransaction,
  user: Principal,
  input: ReportExportInput,
  frozenStoreIds?: readonly string[],
) {
  if (input.kind === 'administration-list') {
    await assertAdministrationCollectionExport(
      tx,
      input.resource === 'stores' && frozenStoreIds
        ? { ...user, storeIds: [...frozenStoreIds] }
        : user,
      input,
    );
    return;
  }
  if (input.kind !== 'current-inventory-workbook' || user.userType !== 2) return;
  const stores = await tx
    .select({ id: Store.id, category: Store.category })
    .from(Store)
    .where(inArray(Store.id, input.storeIds.map(BigInt)))
    .for('share');
  if (
    stores.length !== input.storeIds.length ||
    stores.some((store) => store.category !== 'FRANCHISE')
  )
    throw noAccess();
}
function dto(job: ReportExportJob, user: Principal) {
  return {
    id: job.id,
    origin: 'current' as const,
    kind: job.input.kind,
    reportName:
      job.input.label ||
      (job.input.kind === 'administration-list'
        ? `${job.input.resource} export`
        : {
            'cash-balance': 'Store cash balances',
            'day-close-history': 'Day-close history',
            'returned-orders': 'Returned orders',
            'order-transactions': 'Order transactions',
            'hyperlocal-daily': 'Hyperlocal daily report',
            'flash-sales': 'Flash sales',
            'salesperson-performance': 'Salesperson performance',
            'cashier-performance': 'Staff performance',
            'hyperlocal-acceptance': 'Hyperlocal acceptance',
            'current-inventory-workbook': 'Current inventory workbook',
          }[job.input.kind]),
    note: job.input.note || null,
    from: 'from' in job.input ? job.input.from : null,
    to: 'to' in job.input ? job.input.to : null,
    status: job.status,
    message: workbookFailureMessage(job.errorCode) || exportMessage(job.status),
    requestedBy: job.operatorId,
    requestedAt: job.requestedAt.replace(' ', 'T') + 'Z',
    completedAt: job.completedAt ? job.completedAt.replace(' ', 'T') + 'Z' : null,
    format: reportFileFormat(job.input.kind),
    byteCount: job.byteCount,
    rowCount: job.rowCount,
    canDownload: job.status === 'COMPLETED' && allowed(user, job),
  };
}
export interface ExportWorkerResult {
  jobId: string;
  status: ReportExportJob['status'];
  requestId: string | null;
  userId: string;
  errorCode: string | null;
}
export function reportExportService(
  config: Config,
  db: Databases,
  options: ReportExportOptions,
  store: ReportExportStore | undefined,
  builder: ExportBuilder = reportExportBuilder(config, db),
  clock = () => Temporal.Now.instant(),
  history: Pick<ReturnType<typeof exportHistoryReader>, 'list'> = exportHistoryReader(
    config,
    undefined,
    undefined,
    clock,
  ),
  workbookOptions: InventoryWorkbookOptions = readInventoryWorkbookOptions(),
) {
  const activeBuilds = new Set<AbortController>();
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
  async function metadataAccess(user: Principal, jobs: readonly ReportExportJob[]) {
    const access = new Map(jobs.map((job) => [job.id, allowed(user, job)]));
    const dimensions = jobs.filter((job) => job.input.kind === 'administration-list');
    if (!dimensions.length) return access;
    await transaction(async (tx) => {
      const current = await currentOperator(tx, user.id),
        decisions = new Map<string, boolean>();
      for (const job of dimensions) {
        if (!allowed(current, job)) {
          access.set(job.id, false);
          continue;
        }
        const input = job.input;
        if (input.kind !== 'administration-list') continue;
        const key = JSON.stringify([input.resource, input.active, input.storeIds, job.storeIds]);
        let permitted = decisions.get(key);
        if (permitted === undefined) {
          try {
            await assertExportKindAuthority(tx, current, input, job.storeIds);
            permitted = true;
          } catch (error: unknown) {
            if (!(error instanceof AppError) || ![401, 403].includes(error.status)) throw error;
            permitted = false;
          }
          decisions.set(key, permitted);
        }
        access.set(job.id, permitted);
      }
    });
    return access;
  }
  async function jobFor(tx: AdministrationTransaction, id: string) {
    const [job] = await tx
      .select()
      .from(reportExportJobs)
      .where(eq(reportExportJobs.id, id))
      .limit(1);
    if (!job) throw new AppError(404, 'EXPORT_NOT_FOUND', 'Export not found.');
    return job;
  }
  const tokenWhere = (job: ReportExportJob, status: ReportExportJob['status']) =>
    and(
      eq(reportExportJobs.id, job.id),
      eq(reportExportJobs.claimToken, job.claimToken || ''),
      eq(reportExportJobs.status, status),
    );
  async function setFailed(job: ReportExportJob, errorCode: string) {
    await db
      .get('writer')
      .update(reportExportJobs)
      .set({
        status: 'FAILED',
        errorCode,
        leaseUntil: null,
        claimToken: null,
        updatedAt: instant(clock()),
      })
      .where(
        and(
          eq(reportExportJobs.id, job.id),
          eq(reportExportJobs.claimToken, job.claimToken || ''),
          inArray(reportExportJobs.status, ['BUILDING', 'STORING']),
        ),
      );
  }
  async function authorizeJob(job: ReportExportJob) {
    return transaction(async (tx) => {
      const user = await currentOperator(tx, job.operatorId);
      assertAllowed(user, job);
      await assertExportKindAuthority(tx, user, job.input, job.storeIds);
      return { ...user, storeIds: job.storeIds };
    });
  }
  async function complete(job: ReportExportJob) {
    await db
      .get('writer')
      .update(reportExportJobs)
      .set({
        status: 'COMPLETED',
        errorCode: null,
        claimToken: null,
        leaseUntil: null,
        completedAt: instant(clock()),
        updatedAt: instant(clock()),
      })
      .where(tokenWhere(job, 'STORING'));
  }
  async function process(job: ReportExportJob) {
    const storage = requireStorage();
    const controller = new AbortController();
    let artifact: ExportArtifact | undefined;
    let building = false,
      heartbeat: ReturnType<typeof setInterval> | undefined,
      renewing: Promise<void> | undefined;
    activeBuilds.add(controller);
    const renew = () => {
      if (!building || renewing || controller.signal.aborted) return;
      renewing = transaction(async (tx) => {
        const current = await currentOperator(tx, job.operatorId);
        assertAllowed(current, job);
        await assertExportKindAuthority(tx, current, job.input, job.storeIds);
        const [lease] = await tx
          .select({ token: reportExportJobs.claimToken, status: reportExportJobs.status })
          .from(reportExportJobs)
          .where(eq(reportExportJobs.id, job.id))
          .limit(1)
          .for('update');
        if (!building) return;
        if (!lease || lease.status !== 'BUILDING' || lease.token !== job.claimToken)
          throw new AppError(
            409,
            'EXPORT_LEASE_LOST',
            'This export is already being handled by another worker.',
          );
        await tx
          .update(reportExportJobs)
          .set({ leaseUntil: instant(clock().add({ seconds: 120 })), updatedAt: instant(clock()) })
          .where(tokenWhere(job, 'BUILDING'));
      })
        .catch((error: unknown) => {
          controller.abort(error);
        })
        .finally(() => {
          renewing = undefined;
        });
    };
    try {
      const user = await authorizeJob(job);
      if (job.status === 'STORING') {
        if (!job.artifactKey || !job.checksum || job.byteCount === null)
          throw new AppError(503, 'EXPORT_ARTIFACT_INVALID', 'The export could not be verified.');
        try {
          const artifact = await storage.head(job.artifactKey);
          if (artifact?.checksum === job.checksum && artifact.size === job.byteCount)
            await complete(job);
          else await setFailed(job, 'EXPORT_ARTIFACT_MISSING');
        } catch {
          if (job.recoveryAttempts >= 3) await setFailed(job, 'REPORT_STORAGE_UNAVAILABLE');
          else
            await db
              .get('writer')
              .update(reportExportJobs)
              .set({
                leaseUntil: instant(clock().add({ seconds: 15 })),
                errorCode: 'REPORT_STORAGE_UNAVAILABLE',
                updatedAt: instant(clock()),
              })
              .where(tokenWhere(job, 'STORING'));
        }
        return;
      }
      building = true;
      heartbeat = setInterval(renew, 10000);
      heartbeat.unref();
      artifact = await builder(
        user,
        normalizedExportInput({ ...job.input, storeIds: job.storeIds }),
        { jobId: job.id, signal: controller.signal, maxBytes: options.REPORT_EXPORT_MAX_BYTES },
      );
      building = false;
      clearInterval(heartbeat);
      await renewing;
      controller.signal.throwIfAborted();
      const prepared = prepareExportArtifact(
          artifact,
          reportFileFormat(job.input.kind),
          options.REPORT_EXPORT_MAX_BYTES,
        ),
        checksum = prepared.checksum,
        key = storage.keyFor(job.id, prepared.format);
      const reserved = await transaction(async (tx) => {
        const current = await currentOperator(tx, job.operatorId);
        assertAllowed(current, job);
        await assertExportKindAuthority(tx, current, job.input, job.storeIds);
        const result = await tx
          .update(reportExportJobs)
          .set({
            status: 'STORING',
            artifactKey: key,
            checksum,
            byteCount: prepared.byteCount,
            rowCount: prepared.rowCount,
            leaseUntil: instant(clock().add({ seconds: prepared.format === 'XLSX' ? 120 : 60 })),
            updatedAt: instant(clock()),
          })
          .where(tokenWhere(job, 'BUILDING'));
        return result[0].affectedRows === 1;
      });
      if (!reserved) return;
      try {
        if (prepared.bytes) await storage.put(job.id, prepared.bytes, checksum);
        else if (prepared.file && storage.putArtifact)
          await storage.putArtifact(job.id, prepared.file, prepared.format, controller.signal);
        else
          throw new AppError(
            503,
            'REPORT_STORAGE_UNAVAILABLE',
            'Report storage does not support this file format.',
          );
        await complete(job);
      } catch {
        // The PUT may have succeeded. Reconcile this immutable artifact with HEAD; never rebuild it.
        await db
          .get('writer')
          .update(reportExportJobs)
          .set({
            leaseUntil: instant(clock().add({ seconds: 15 })),
            errorCode: 'UPLOAD_OUTCOME_UNKNOWN',
            updatedAt: instant(clock()),
          })
          .where(tokenWhere(job, 'STORING'));
      }
    } catch (error) {
      const code =
        workbookFailureCode(error) ||
        (error instanceof AppError &&
        [
          'AUTH_REQUIRED',
          'EXPORT_ACCESS_DENIED',
          'EXPORT_TOO_LARGE',
          'DEPENDENCY_UNAVAILABLE',
          'INVALID_DATE_RANGE',
        ].includes(error.code)
          ? error.code
          : 'EXPORT_BUILD_FAILED');
      await setFailed(job, code);
    } finally {
      building = false;
      if (heartbeat) clearInterval(heartbeat);
      await renewing;
      activeBuilds.delete(controller);
      if (artifact && 'file' in artifact) await artifact.file.dispose();
    }
  }
  return {
    async create(
      user: Principal,
      commandId: string,
      value: unknown,
      requestId: string | null = null,
    ) {
      requireStorage();
      const input = normalizedExportInput(value);
      input.storeIds.forEach((id) => requireStore(user, id));
      const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      return transaction(async (tx) => {
        const current = await currentOperator(tx, user.id, 'update');
        if (managerReportExport(input.kind) && current.role !== 1) throw noAccess();
        await assertExportKindAuthority(tx, current, input);
        if (
          requiresSelectedExportStores(input.kind) ||
          ((input.kind === 'hyperlocal-daily' || managerReportExport(input.kind)) &&
            current.userType === 2)
        )
          orderReportScope(current, input.storeIds);
        input.storeIds.forEach((id) => requireStore(current, id));
        const [existing] = await tx
          .select()
          .from(reportExportJobs)
          .where(
            and(
              eq(reportExportJobs.operatorId, current.id),
              eq(reportExportJobs.commandId, commandId),
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This request identifier was already used for another export.',
            );
          assertAllowed(current, existing);
          return dto(existing, current);
        }
        const [pending] = await tx
          .select({ count: count() })
          .from(reportExportJobs)
          .where(
            and(
              eq(reportExportJobs.operatorId, current.id),
              inArray(reportExportJobs.status, ['QUEUED', 'BUILDING', 'STORING']),
            ),
          );
        if ((pending?.count || 0) >= options.REPORT_EXPORT_MAX_PENDING_PER_USER)
          throw new AppError(
            429,
            'EXPORT_QUEUE_LIMIT',
            'Wait for an existing export to finish before requesting another.',
          );
        const dimensionScope =
          input.kind === 'administration-list' ? collectionExportScope(current, input) : null;
        const now = instant(clock()),
          job: ReportExportJob = {
            id: randomUUID(),
            operatorId: current.id,
            commandId,
            requestId,
            requestHash,
            input,
            storeIds: dimensionScope
              ? dimensionScope.storeIds
              : input.kind === 'flash-sales' && current.userType === 2
                ? current.storeIds
                : requiresSelectedExportStores(input.kind) ||
                    (managerReportExport(input.kind) && current.userType === 2)
                  ? input.storeIds
                  : input.storeIds.length
                    ? input.storeIds
                    : current.role === 1 &&
                        !(
                          (input.kind === 'hyperlocal-daily' || managerReportExport(input.kind)) &&
                          current.userType === 2
                        )
                      ? []
                      : current.storeIds,
            requiresGlobal: dimensionScope
              ? dimensionScope.requiresGlobal
              : !requiresSelectedExportStores(input.kind) &&
                current.role === 1 &&
                !(
                  (input.kind === 'hyperlocal-daily' || managerReportExport(input.kind)) &&
                  current.userType === 2
                ) &&
                !input.storeIds.length,
            requesterUserType: current.userType,
            status: 'QUEUED',
            claimToken: null,
            leaseUntil: null,
            recoveryAttempts: 0,
            artifactKey: null,
            checksum: null,
            byteCount: null,
            rowCount: null,
            errorCode: null,
            requestedAt: now,
            completedAt: null,
            updatedAt: now,
          };
        await tx.insert(reportExportJobs).values(job);
        return dto(job, current);
      });
    },
    async read(user: Principal, id: string) {
      return transaction(async (tx) => {
        const current = await currentOperator(tx, user.id),
          job = await jobFor(tx, id);
        assertAllowed(current, job);
        await assertExportKindAuthority(tx, current, job.input, job.storeIds);
        return dto(job, current);
      });
    },
    async list(
      user: Principal,
      selection: 'current' | 'legacy' | ExportHistoryInput = 'current',
      page = 1,
      pageSize = 25,
    ): Promise<{
      data: ReportExportListRow[];
      total: number;
      page: number;
      pageSize: number;
      reader: 'primary' | 'bigquery';
    }> {
      const input = exportHistoryInputSchema.parse(
          typeof selection === 'string' ? { origin: selection, page, pageSize } : selection,
        ),
        current = await transaction((tx) => currentOperator(tx, user.id));
      // report_exports.is_completed is nullable; NULL is not complete.
      const legacyFileAllowed = (row: { complete: boolean | null; format: string; file: string }) =>
        current.role === 1 &&
        current.userType === 1 &&
        row.complete === true &&
        parsedReportFileFormat(row.format) !== null &&
        row.file
          .toLowerCase()
          .endsWith('.' + reportFileExtension(parsedReportFileFormat(row.format)!)) &&
        row.file.startsWith(options.S3_LEGACY_REPORT_EXPORT_FOLDER_PATH + '/') &&
        !/[\p{C}\\]/u.test(row.file) &&
        !row.file.split('/').some((part) => part === '.' || part === '..');
      const withNames = async (data: ReportExportListRow[]) => {
        const ids = [...new Set(data.map((row) => row.requestedBy))],
          names = ids.length
            ? await db
                .get('primary')
                .select({ id: PosUser.id, name: PosUser.username })
                .from(PosUser)
                .where(inArray(PosUser.id, ids.map(BigInt)))
            : [],
          mapped = new Map(names.map((row) => [String(row.id), row.name]));
        return data.map((row) => ({
          ...row,
          requestedByName: mapped.get(row.requestedBy) || row.requestedBy,
        }));
      };
      if (input.period === 'archive') {
        const result = await history.list(current, input),
          ids = result.data.map((row) => row.id);
        if (current.role !== 1 && result.data.some((row) => row.requestedBy !== current.id))
          throw new AppError(
            503,
            'EXPORT_HISTORY_VIEW_INVALID',
            'Archived export metadata does not match the required data contract.',
          );
        if (input.origin === 'current') {
          const jobs = ids.length
              ? await db
                  .get('writer')
                  .select()
                  .from(reportExportJobs)
                  .where(inArray(reportExportJobs.id, ids))
              : [],
            permitted = await metadataAccess(current, jobs),
            eligible = new Map(
              jobs.map((job) => [job.id, job.status === 'COMPLETED' && permitted.get(job.id)]),
            );
          return {
            ...result,
            data: await withNames(
              result.data.map((row) => ({ ...row, canDownload: eligible.get(row.id) || false })),
            ),
            reader: 'bigquery',
          };
        }
        const files = ids.length
            ? await db
                .get('writer')
                .select({
                  id: ReportExport.id,
                  complete: ReportExport.is_completed,
                  format: ReportExport.export_format,
                  file: ReportExport.export_file_url,
                })
                .from(ReportExport)
                .where(inArray(ReportExport.id, ids.map(BigInt)))
            : [],
          eligible = new Map(files.map((row) => [String(row.id), legacyFileAllowed(row)]));
        return {
          ...result,
          data: await withNames(
            result.data.map((row) => ({ ...row, canDownload: eligible.get(row.id) || false })),
          ),
          reader: 'bigquery',
        };
      }
      const primary = db.get('primary'),
        offset = (input.page - 1) * input.pageSize,
        bounds = exportHistoryBounds(config, input, clock()),
        pattern = '%' + input.search.replace(/[\\%_]/g, (value) => '\\' + value) + '%';
      if (input.origin === 'current') {
        const kind = sql<string>`json_unquote(json_extract(${reportExportJobs.input},'$.kind'))`,
          name = sql<string>`coalesce(nullif(json_unquote(json_extract(${reportExportJobs.input},'$.label')),''),case ${kind} when 'day-close-history' then 'Day-close history' when 'cash-balance' then 'Store cash balances' when 'returned-orders' then 'Returned orders' when 'order-transactions' then 'Order transactions' when 'hyperlocal-daily' then 'Hyperlocal daily report' when 'flash-sales' then 'Flash sales' when 'salesperson-performance' then 'Salesperson performance' when 'cashier-performance' then 'Staff performance' when 'hyperlocal-acceptance' then 'Hyperlocal acceptance' when 'administration-list' then concat(json_unquote(json_extract(${reportExportJobs.input},'$.resource')),' export') else ${kind} end)`,
          note = sql<string>`json_unquote(json_extract(${reportExportJobs.input},'$.note'))`,
          period = sql<string>`case ${kind} when 'administration-list' then 'Current collection' when 'current-inventory-workbook' then 'Current snapshot' else concat(coalesce(json_unquote(json_extract(${reportExportJobs.input},'$.from')),''),' – ',coalesce(json_unquote(json_extract(${reportExportJobs.input},'$.to')),'')) end`,
          message = sql<string>`case ${reportExportJobs.status} when 'QUEUED' then 'Waiting to prepare the report.' when 'BUILDING' then 'Preparing the report.' when 'STORING' then 'Verifying the report file.' when 'COMPLETED' then 'Report file is ready.' else 'The export could not be completed. Request a new export.' end`,
          recent = or(
            inArray(reportExportJobs.status, ['QUEUED', 'BUILDING', 'STORING']),
            gte(
              sql`coalesce(${reportExportJobs.completedAt},${reportExportJobs.updatedAt},${reportExportJobs.requestedAt})`,
              bounds.cutoff,
            ),
          ),
          scope = and(
            current.role === 1 ? undefined : eq(reportExportJobs.operatorId, current.id),
            recent,
            input.search
              ? or(
                  like(name, pattern),
                  like(kind, pattern),
                  like(message, pattern),
                  like(note, pattern),
                  like(reportExportJobs.status, pattern),
                  like(reportExportJobs.operatorId, pattern),
                  sql`cast(${reportExportJobs.requestedAt} as char) like ${pattern}`,
                )
              : undefined,
          ),
          sort = {
            id: reportExportJobs.id,
            kind,
            period,
            message,
            format: sql`case when ${kind}='current-inventory-workbook' then 'XLSX' else 'CSV' end`,
            requested_at: reportExportJobs.requestedAt,
            completed_at: reportExportJobs.completedAt,
            report_name: name,
            status: reportExportJobs.status,
            requested_by: sql`cast(${reportExportJobs.operatorId} as unsigned)`,
            row_count: reportExportJobs.rowCount,
            byte_count: reportExportJobs.byteCount,
          }[input.sort];
        const [totals, rows] = await Promise.all([
          primary.select({ total: count() }).from(reportExportJobs).where(scope),
          primary
            .select()
            .from(reportExportJobs)
            .where(scope)
            .orderBy(input.direction === 'asc' ? asc(sort) : desc(sort), desc(reportExportJobs.id))
            .limit(input.pageSize)
            .offset(offset),
        ]);
        const permitted = await metadataAccess(current, rows);
        return {
          data: await withNames(
            rows.map((job) => ({
              ...dto(job, current),
              canDownload: job.status === 'COMPLETED' && !!permitted.get(job.id),
            })),
          ),
          total: totals[0]?.total || 0,
          page: input.page,
          pageSize: input.pageSize,
          reader: 'primary',
        };
      }
      const active = and(
          eq(ReportExport.is_completed, false),
          sql`lower(${ReportExport.export_status}) not in ('failed','error')`,
        ),
        recent = or(
          active,
          gte(
            sql`coalesce(${ReportExport.export_completed_at},${ReportExport.updated_at},${ReportExport.export_requested_at})`,
            bounds.cutoff,
          ),
        ),
        scope = and(
          current.role === 1 && current.userType === 1
            ? undefined
            : eq(ReportExport.export_requested_by, sql`${current.id}`),
          recent,
          input.search
            ? or(
                like(ReportExport.report_name, pattern),
                like(ReportExport.report_type, pattern),
                like(ReportExport.export_status, pattern),
                sql`cast(${ReportExport.export_requested_at} as char) like ${pattern}`,
              )
            : undefined,
        ),
        sort = {
          id: ReportExport.id,
          kind: ReportExport.report_type,
          period: ReportExport.time_period,
          message: sql`case when ${ReportExport.is_completed}=1 then 'Report file is ready.' when lower(${ReportExport.export_status}) in ('failed','error') then 'The export could not be completed. Request a new export.' else 'Waiting to prepare the report.' end`,
          format: ReportExport.export_format,
          requested_at: ReportExport.export_requested_at,
          completed_at: ReportExport.export_completed_at,
          report_name: ReportExport.report_name,
          status: ReportExport.export_status,
          requested_by: ReportExport.export_requested_by,
          row_count: ReportExport.export_rows_count,
          byte_count: ReportExport.export_size,
        }[input.sort];
      const [totals, rows] = await Promise.all([
        primary.select({ total: count() }).from(ReportExport).where(scope),
        primary
          .select({
            id: ReportExport.id,
            name: ReportExport.report_name,
            period: ReportExport.time_period,
            type: ReportExport.report_type,
            status: ReportExport.export_status,
            complete: ReportExport.is_completed,
            requestedBy: ReportExport.export_requested_by,
            requestedAt: ReportExport.export_requested_at,
            completedAt: ReportExport.export_completed_at,
            format: ReportExport.export_format,
            size: ReportExport.export_size,
            rowCount: ReportExport.export_rows_count,
            file: ReportExport.export_file_url,
          })
          .from(ReportExport)
          .where(scope)
          .orderBy(input.direction === 'asc' ? asc(sort) : desc(sort), desc(ReportExport.id))
          .limit(input.pageSize)
          .offset(offset),
      ]);
      const legacyInstant = (value: string | null) =>
        value && !value.startsWith('0000-00-00')
          ? Temporal.PlainDateTime.from(value.replace(' ', 'T'))
              .toZonedDateTime(config.BUSINESS_TIMEZONE)
              .toInstant()
              .toString()
          : null;
      const data: ReportExportListRow[] = rows.map((row) => {
        const status = row.complete
          ? ('COMPLETED' as const)
          : ['FAILED', 'ERROR'].includes((row.status ?? '').toUpperCase())
            ? ('FAILED' as const)
            : ('QUEUED' as const);
        return {
          id: String(row.id),
          origin: 'legacy',
          kind: row.type,
          reportName: row.name || row.type || 'Legacy report',
          note: null,
          period: row.period,
          from: null,
          to: null,
          status,
          message: exportMessage(status),
          requestedBy: String(row.requestedBy),
          requestedAt: legacyInstant(row.requestedAt),
          completedAt: legacyInstant(row.completedAt),
          format: row.format,
          byteCount: row.size * 1024,
          rowCount: row.rowCount,
          canDownload: legacyFileAllowed(row),
        };
      });
      return {
        data: await withNames(data),
        total: totals[0]?.total || 0,
        page: input.page,
        pageSize: input.pageSize,
        reader: 'primary',
      };
    },
    async download(user: Principal, id: string, signal?: AbortSignal) {
      const job = await transaction(async (tx) => {
        const current = await currentOperator(tx, user.id),
          job = await jobFor(tx, id);
        assertAllowed(current, job);
        await assertExportKindAuthority(tx, current, job.input, job.storeIds);
        if (
          job.status !== 'COMPLETED' ||
          !job.artifactKey ||
          !job.checksum ||
          job.byteCount === null
        )
          throw new AppError(409, 'EXPORT_NOT_READY', 'This export is not ready to download.');
        return job;
      });
      const file = await requireStorage().stream(
        job.artifactKey!,
        { size: job.byteCount!, checksum: job.checksum! },
        false,
        signal,
      );
      return {
        ...file,
        filename: (job.input.kind === 'current-inventory-workbook'
          ? `inventory-${job.id}.xlsx`
          : job.input.kind === 'administration-list'
            ? `administration-${job.id}.csv`
            : `${job.input.kind}-${job.input.from}-${job.input.to}.csv`
        ).replaceAll(':', '-'),
        contentType: reportFileContentType(reportFileFormat(job.input.kind)),
      };
    },
    async downloadLegacy(user: Principal, id: string, signal?: AbortSignal) {
      const row = await transaction(async (tx) => {
        const current = await currentOperator(tx, user.id);
        if (current.role !== 1 || current.userType !== 1) throw noAccess();
        const [row] = await tx
          .select()
          .from(ReportExport)
          .where(eq(ReportExport.id, BigInt(id)))
          .limit(1);
        if (!row) throw new AppError(404, 'EXPORT_NOT_FOUND', 'Export not found.');
        if (
          !row.is_completed ||
          !parsedReportFileFormat(row.export_format) ||
          !row.export_file_url ||
          /^https?:/i.test(row.export_file_url)
        )
          throw new AppError(409, 'EXPORT_NOT_READY', 'This legacy export is unavailable.');
        return row;
      });
      const format = parsedReportFileFormat(row.export_format)!;
      if (!row.export_file_url.toLowerCase().endsWith('.' + reportFileExtension(format)))
        throw legacyWorkbookUnverified();
      const bounded = signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(workbookOptions.INVENTORY_WORKBOOK_MAX_BUILD_MS),
          ])
        : AbortSignal.timeout(workbookOptions.INVENTORY_WORKBOOK_MAX_BUILD_MS);
      const file = await requireStorage().stream(row.export_file_url, undefined, true, bounded);
      if (format === 'XLSX') {
        if (file.contentType !== reportFileContentType('XLSX')) {
          file.body.destroy();
          throw legacyWorkbookUnverified();
        }
        const accepted = await safeLegacyWorkbookStream(
          file.body,
          workbookOptions,
          options.REPORT_EXPORT_MAX_BYTES,
          bounded,
        );
        return {
          ...accepted,
          filename: `legacy-report-${id}.xlsx`,
          contentType: reportFileContentType(format),
        };
      }
      return {
        ...file,
        filename: `legacy-report-${id}.csv`,
        contentType: reportFileContentType(format),
      };
    },
    abortBuilds() {
      for (const controller of activeBuilds)
        controller.abort(
          new AppError(
            503,
            'EXPORT_BUILD_ABORTED',
            'Report preparation stopped before completion.',
          ),
        );
    },
    async runOne(): Promise<ExportWorkerResult | null> {
      if (!store) return null;
      const now = clock();
      await db
        .get('writer')
        .update(reportExportJobs)
        .set({
          status: 'FAILED',
          errorCode: 'BUILD_INTERRUPTED',
          claimToken: null,
          leaseUntil: null,
          updatedAt: instant(now),
        })
        .where(
          and(
            eq(reportExportJobs.status, 'BUILDING'),
            lt(reportExportJobs.leaseUntil, instant(now)),
          ),
        );
      const job = await transaction(async (tx) => {
        const [selected] = await tx
          .select()
          .from(reportExportJobs)
          .where(
            or(
              eq(reportExportJobs.status, 'QUEUED'),
              and(
                eq(reportExportJobs.status, 'STORING'),
                or(
                  isNull(reportExportJobs.leaseUntil),
                  lt(reportExportJobs.leaseUntil, instant(now)),
                ),
              ),
            ),
          )
          .orderBy(asc(reportExportJobs.requestedAt), asc(reportExportJobs.id))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!selected) return null;
        const claimed = {
          ...selected,
          status: selected.status === 'QUEUED' ? ('BUILDING' as const) : ('STORING' as const),
          claimToken: randomUUID(),
          leaseUntil: instant(now.add({ seconds: 120 })),
          recoveryAttempts: selected.recoveryAttempts + (selected.status === 'STORING' ? 1 : 0),
          updatedAt: instant(now),
        };
        await tx
          .update(reportExportJobs)
          .set({
            status: claimed.status,
            claimToken: claimed.claimToken,
            leaseUntil: claimed.leaseUntil,
            recoveryAttempts: claimed.recoveryAttempts,
            updatedAt: claimed.updatedAt,
          })
          .where(eq(reportExportJobs.id, selected.id));
        return claimed;
      });
      if (!job) return null;
      await process(job);
      const [result] = await db
        .get('writer')
        .select({ status: reportExportJobs.status, errorCode: reportExportJobs.errorCode })
        .from(reportExportJobs)
        .where(eq(reportExportJobs.id, job.id))
        .limit(1);
      return {
        jobId: job.id,
        status: result?.status || 'FAILED',
        requestId: job.requestId,
        userId: job.operatorId,
        errorCode: result?.errorCode || null,
      };
    },
  };
}
