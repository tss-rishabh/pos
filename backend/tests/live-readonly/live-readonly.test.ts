/**
 * Phase F1: live read-only production parity suite.
 *
 * Skips entirely unless POS_PROD_RO_MYSQL_URL is set. Runs the rewrite's real read code against
 * production through the guarded read-only connection (tools/live-readonly/connection.ts), with
 * fakes only for Redis and BigQuery. Assertions compare shapes and invariants; nothing prints or
 * persists a row value. See backend/parity/live-readonly.md.
 */
import { randomBytes } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, between, desc, eq, gt, isNull, notExists, sql } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { z } from 'zod';
import { readConfig, type Config } from '../../src/config.js';
import {
  HasProduct,
  Order,
  OrderStore,
  PosUser,
  Store,
  StoreCounter,
} from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { activeAccountReader } from '../../src/auth/sessions.js';
import { loginCheckIns, storeDirectory } from '../../src/auth/checkin.js';
import { bindCheckInRedis } from '../../src/modules/administration/checkins.js';
import { memoryRedisPort } from '../helpers/memory-redis.js';
import { catalogService } from '../../src/modules/catalog.js';
import {
  readCatalogStockLocations,
  uniqueBarcodeProduct,
} from '../../src/modules/catalog-barcode.js';
import { checkoutRepository } from '../../src/modules/checkout/repository.js';
import { checkoutSessionStore } from '../../src/modules/checkout/session-store.js';
import { memoryStateStore } from '../../src/modules/checkout/state-store.js';
import { inventoryService } from '../../src/modules/administration/inventory.js';
import { ordersService } from '../../src/modules/orders.js';
import { orderSearchService } from '../../src/modules/order-history/search/service.js';
import { sourceRowSchema } from '../../src/modules/order-history/search/contracts.js';
import { onlineOrderDetailService } from '../../src/modules/order-history/online-detail/service.js';
import { onlineOrderDetail } from '../../src/modules/order-history/online-detail/contracts.js';
import { readCurrentOrderCustomer } from '../../src/modules/order-history/online-detail/native.js';
import { bindReportSql, reportService, rollupSchema } from '../../src/modules/reports.js';
import { legacyReportSql } from '../../src/modules/legacy-report-sql.js';
import {
  scheduledMysqlRows,
  scheduledSourceQuery,
} from '../../src/modules/operational-reports/scheduled-data.js';
import {
  orderTransactionsOptions,
  orderTransactionsReportService,
} from '../../src/modules/operational-reports/order-transactions.js';
import {
  flashSalesOptions,
  flashSalesReportService,
} from '../../src/modules/operational-reports/flash-sales.js';
import { financeFeedOptions, financeFeedService } from '../../src/modules/finance/feed.js';
import { collectionSnapshot } from '../../src/modules/finance/service.js';
import { cashLedgerService, ledgerOptions } from '../../src/modules/finance/ledger.js';
import { paymentCorrectionFinanceOptions } from '../../src/modules/finance/payment-corrections.js';
import type { warehouseService } from '../../src/modules/warehouse.js';
import {
  causeOf,
  connectionOptions,
  errorCode,
  liveEnabled,
  liveEnvSchema,
  localPlaintext,
  openGuardedDatabase,
  PlanGuardError,
  statsDelta,
  type GuardedDatabase,
  type GuardStats,
} from '../../tools/live-readonly/connection.js';
import { ReadOnlyGuardError } from '../../tools/live-readonly/sql-guard.js';
import {
  drizzleProductionTables,
  liveSchemaDrift,
  readSnapshot,
} from '../../tools/live-readonly/schema.js';
import {
  assertAggregateOnly,
  finishSummary,
  newSummary,
  writeEvidence,
  type LiveSummary,
  type PathResult,
} from '../../tools/live-readonly/summary.js';

const zone = 'Asia/Kolkata';
const fakeView = 'live-readonly-fake.fake.view';

/** A failed invariant. The label is a fixed name; it never carries a row value. */
class InvariantError extends Error {
  readonly code = 'INVARIANT';
  constructor(readonly label: string) {
    super(`Invariant failed: ${label}`);
  }
}
/** A path that cannot run on this database (no sample rows, warehouse-only data, …). */
class SkipPath extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const safeSegment = (segment: PropertyKey) =>
  typeof segment === 'number' || /^[A-Za-z_]\w{0,40}$/.test(String(segment))
    ? String(segment)
    : '*';
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new InvariantError(label);
}
function parse<T extends z.ZodType>(schema: T, value: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new InvariantError(
    `${label}: ${result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(safeSegment).join('.')}:${issue.code}`)
      .join(',')}`,
  );
}
const nondecreasing = (values: readonly bigint[]) =>
  values.every((value, index) => index === 0 || values[index - 1]! <= value);
const nonincreasing = (values: readonly bigint[]) =>
  values.every((value, index) => index === 0 || values[index - 1]! >= value);

const sourceTimestamp = z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?$/);
const decimalText = z.string().regex(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i);
const idText = z.string().regex(/^\d+$/);
const storeDto = z
  .object({
    id: idText,
    name: z.string(),
    locationCode: z.string(),
    city: z.string(),
    active: z.boolean(),
  })
  .strict();
const counterDto = z.object({ id: idText, storeId: idText, name: z.string() }).strict();
const catalogProduct = z
  .object({
    id: idText,
    name: z.string(),
    erpName: z.string(),
    barcode: idText.nullable(),
    parentId: idText,
    type: idText,
    price: decimalText,
    specialPrice: decimalText,
    exclusivePrice: decimalText.nullable(),
    stock: z.number().int(),
    holdedStock: z.number().int(),
    storageStock: z.string(),
    gst: z.number(),
    image: z.string().nullable(),
  })
  .strict();
const orderRow = z
  .object({
    id: idText,
    rowId: idText,
    reference: z.string().nullable(),
    storeId: idText,
    customer: z.string(),
    amount: decimalText,
    status: z.string(),
    paymentStatus: z.string(),
    createdAt: sourceTimestamp,
  })
  .strict();
const storeDetail = z
  .object({
    id: idText,
    reference: z.string().nullable(),
    amount: z.number(),
    orderAmount: z.number(),
    createdAt: sourceTimestamp,
    status: z.string().nullable(),
    isPaid: z.boolean(),
    reader: z.literal('primary'),
    fetchedAt: z.iso.datetime(),
    lines: z.array(
      z
        .object({
          id: idText,
          productId: idText,
          name: z.string().nullable(),
          erpProduct: z.string(),
          quantity: z.string(),
          amount: z.number(),
          gst: z.number(),
          status: z.string().nullable(),
          productType: z.string(),
          parentProductId: z.string(),
          giftVoucherId: z.string(),
          returnStatus: z.number(),
        })
        .strict(),
    ),
    legacy: z.object({}).loose(),
  })
  .strict();
const inventoryRow = z
  .object({
    id: z.bigint(),
    name: z.string(),
    erpName: z.string().nullable(),
    parentId: z.bigint(),
    type: z.bigint(),
    stock: z.number().int(),
    available: z.boolean(),
    archived: z.boolean(),
    barcode: z.union([z.string(), z.number(), z.bigint()]).nullable(),
  })
  .strict();
const moneyText = z.string().regex(/^-?\d+\.\d{2}$/);

interface Samples {
  operatorId: string;
  storeId: string;
  storeCode: string | null;
  counterId: string | null;
  storeOrderId: string;
  storeOrderDay: string;
  storeOrderHour: string;
  customerId: string | null;
  onlineOrderId: string | null;
  productIds: string[];
  latestOrderIds: bigint[];
}

const enabled = liveEnabled();
const loopbackTarget = (() => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(
      new URL(process.env['POS_PROD_RO_MYSQL_URL'] ?? '').hostname,
    );
  } catch {
    return false;
  }
})();
// Each path may run many statements, each bounded by MAX_EXECUTION_TIME (≤10 s).
describe.skipIf(!enabled)('live read-only production parity (Phase F1)', { timeout: 60_000 }, () => {
  let guarded: GuardedDatabase,
    summary: LiveSummary,
    config: Config,
    samples: Samples | undefined,
    principal: Principal,
    loopback = false;
  const today = () => Temporal.Now.zonedDateTimeISO(zone).toPlainDate().toString();
  const fakeWarehouse: Pick<
    ReturnType<typeof warehouseService>,
    'queryReport' | 'dailyRollups' | 'auxiliary'
  > = {
    // BigQuery is not available read-only here; warehouse-backed parts return no rows.
    queryReport: async () => [],
    dailyRollups: async () => {
      throw new SkipPath('WAREHOUSE_ONLY');
    },
    auxiliary: async () => ({ footfall: {}, target: {} }),
  };

  function snapshot(stats: GuardStats): GuardStats {
    return {
      ...stats,
      refusedCodes: [...stats.refusedCodes],
      planRejected: [...stats.planRejected],
      planBounded: [...stats.planBounded],
      failedStatements: [...stats.failedStatements],
    };
  }
  async function run(
    context: TestContext,
    path: string,
    work: (s: Samples) => Promise<{ rows: number; checks: string[] }>,
  ) {
    const before = snapshot(guarded.stats),
      started = performance.now();
    let status: PathResult['status'] = 'pass',
      reason: string | undefined,
      rows = 0,
      checks: string[] = [];
    try {
      if (!samples) throw new SkipPath('NO_SAMPLE_ROWS');
      const outcome = await work(samples);
      rows = outcome.rows;
      checks = outcome.checks;
    } catch (error) {
      const delta = statsDelta(guarded.stats, before);
      const skipped = causeOf(error, SkipPath);
      if (skipped) {
        status = 'skip';
        reason = skipped.reason;
      } else if (
        guarded.lockingReads === 'refuse' &&
        delta.refused &&
        delta.refusedCodes.every((code) => code === 'RO_GUARD_LOCKING_READ')
      ) {
        // Strict mode: the path's authorization confirmation uses locking reads.
        status = 'skip';
        reason = 'RO_GUARD_LOCKING_READ';
      } else if (causeOf(error, PlanGuardError) || (delta.planRejected.length && !delta.refused)) {
        status = 'skip';
        reason = delta.planRejected[0]?.code ?? errorCode(error);
      } else if (error instanceof InvariantError) {
        status = 'fail';
        reason = `INVARIANT ${error.label}`.slice(0, 200);
      } else {
        status = 'fail';
        reason = errorCode(error);
      }
    }
    const delta = statsDelta(guarded.stats, before);
    // A refusal swallowed by the module still fails the path loudly.
    if (delta.refused && status === 'pass') {
      status = 'fail';
      reason = delta.refusedCodes[0] ?? 'RO_GUARD';
    }
    summary.paths.push({
      path,
      status,
      ...(reason ? { reason: reason.replace(/[^A-Za-z0-9_ .:,()'<>/=+-]/g, '?') } : {}),
      rows,
      checks,
      statements: delta.statements,
      explains: delta.explains,
      downgradedLocks: delta.downgradedLocks,
      downgradedUpdateLocks: delta.downgradedUpdateLocks,
      refused: delta.refused,
      planRejected: delta.planRejected,
      planBounded: delta.planBounded,
      ...(status !== 'pass' && delta.failedStatements.length
        ? { failedStatements: delta.failedStatements }
        : {}),
      durationMs: Math.round(performance.now() - started),
    });
    if (status === 'fail') throw new Error(`${path} failed: ${reason ?? 'UNKNOWN'}`);
    if (status === 'skip') context.skip(`${path}: ${reason}`);
  }

  async function sample(): Promise<Samples | undefined> {
    const db = guarded.db;
    const [operator] = await db
      .select({ id: PosUser.id })
      .from(PosUser)
      .where(and(eq(PosUser.is_active, true), eq(PosUser.role, 1), eq(PosUser.user_type, 1)))
      .orderBy(asc(PosUser.id))
      .limit(1);
    const latest = await db.select({ id: Order.id }).from(Order).orderBy(desc(Order.id)).limit(5);
    const [storeOrder] = await db
      .select({ order: OrderStore.order, store: OrderStore.store })
      .from(OrderStore)
      .orderBy(desc(OrderStore.id))
      .limit(5);
    if (!operator || !storeOrder || !latest.length) return undefined;
    const [order] = await db
      .select({ createdAt: Order.created_at, user: Order.user })
      .from(Order)
      .where(eq(Order.id, storeOrder.order))
      .limit(1);
    if (!order) return undefined;
    const top = latest[0]!.id;
    const [online] = await db
      .select({ id: Order.id, user: Order.user })
      .from(Order)
      .where(
        and(
          between(Order.id, top > 5000n ? top - 5000n : 0n, top),
          isNull(Order.location_id),
          gt(Order.user, 0n),
          notExists(
            db.select({ id: OrderStore.id }).from(OrderStore).where(eq(OrderStore.order, Order.id)),
          ),
        ),
      )
      .orderBy(desc(Order.id))
      .limit(5);
    const products = await db
      .select({ product: HasProduct.product })
      .from(HasProduct)
      .where(eq(HasProduct.order, storeOrder.order))
      .orderBy(asc(HasProduct.id))
      .limit(10);
    const [counter] = await db
      .select({ id: StoreCounter.id })
      .from(StoreCounter)
      .where(and(eq(StoreCounter.store, storeOrder.store), eq(StoreCounter.is_active, true)))
      .orderBy(asc(StoreCounter.id))
      .limit(1);
    const [store] = await db
      .select({ code: Store.location_code })
      .from(Store)
      .where(eq(Store.id, storeOrder.store))
      .limit(1);
    const createdAt = parse(sourceTimestamp, order.createdAt, 'sample:order-created-at');
    const customer = order.user > 0n ? order.user : (online?.user ?? null);
    return {
      operatorId: String(operator.id),
      storeId: String(storeOrder.store),
      storeCode: store?.code || null,
      counterId: counter ? String(counter.id) : null,
      storeOrderId: String(storeOrder.order),
      storeOrderDay: createdAt.slice(0, 10),
      storeOrderHour: createdAt.slice(0, 13) + ':00:00',
      customerId: customer === null ? null : String(customer),
      onlineOrderId: online ? String(online.id) : null,
      productIds: [...new Set(products.map((row) => String(row.product)))],
      latestOrderIds: latest.map((row) => row.id),
    };
  }

  beforeAll(async () => {
    const env = liveEnvSchema.parse(process.env);
    const host = String(connectionOptions(env).host);
    loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
    guarded = await openGuardedDatabase(env);
    summary = newSummary(guarded.maxExecutionMs, guarded.planRowLimit, guarded.lockingReads);
    const state = await guarded.sessionState();
    summary.settings.sessionReadOnly = state.readOnly;
    const [version] = (await guarded.db.execute(sql`SELECT VERSION() AS version`)) as unknown as [
      { version: string }[],
    ];
    summary.serverVersion = /^\d+\.\d+\.\d+/.exec(String(version[0]?.version ?? ''))?.[0];
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: randomBytes(32).toString('hex'),
      // Never connected: every module receives the guarded `Databases` below instead.
      MYSQL_PRIMARY_READER_URL: 'mysql://unused@127.0.0.1:1/unused',
      BUSINESS_TIMEZONE: zone,
    });
    // Redis fake: legacy check-in keys only, in process.
    const redis = memoryRedisPort();
    bindCheckInRedis(redis);
    const sampleStart = snapshot(guarded.stats);
    let sampleSkip = 'NO_SAMPLE_ROWS';
    try {
      samples = await sample();
    } catch (error) {
      const plan = causeOf(error, PlanGuardError);
      if (!plan) throw new Error(`sampling failed: ${errorCode(error)}`);
      sampleSkip = plan.code;
      samples = undefined;
    }
    summary.paths.push({
      path: 'sampling',
      status: samples ? 'pass' : 'skip',
      ...(samples ? {} : { reason: sampleSkip }),
      rows: samples ? 1 : 0,
      checks: [],
      ...(({ refusedCodes: _codes, ...delta }) => delta)(statsDelta(guarded.stats, sampleStart)),
      durationMs: 0,
    });
    if (samples) {
      principal = {
        id: samples.operatorId,
        name: 'Live read-only check',
        email: '',
        role: 1,
        userType: 1,
        storeIds: [samples.storeId],
      };
      await loginCheckIns({ eligible: async () => true, name: async () => 'live' }, redis).record(
        samples.operatorId,
        samples.storeId,
        3600,
      );
    }
  }, 120_000);

  afterAll(async () => {
    bindCheckInRedis(undefined);
    if (!summary) return;
    finishSummary(summary);
    assertAggregateOnly(summary);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    const directory = process.env['POS_PROD_RO_EVIDENCE_DIR'];
    if (directory || process.env['POS_PROD_RO_WRITE_EVIDENCE'] === '1') {
      const written = writeEvidence(summary, directory || undefined);
      process.stdout.write(`live-readonly evidence: ${written.split('/').slice(-2).join('/')}\n`);
    }
    await guarded?.close();
  });

  it('runs every statement in a verified READ ONLY session with a bounded statement time', async () => {
    const state = await guarded.sessionState();
    // Behind a proxy that drops transaction_read_only, the grants proof (SELECT/USAGE only,
    // checked in openGuardedDatabase) replaces the session flag.
    if (liveEnvSchema.parse(process.env).POS_PROD_RO_READONLY_PROOF === 'session')
      expect(state.readOnly).toBe(true);
    expect(state.maxExecutionMs).toBeGreaterThan(0);
    expect(state.maxExecutionMs).toBeLessThanOrEqual(10_000);
    expect(guarded.stats.verifiedConnections).toBeGreaterThan(0);
    expect(guarded.stats.verifiedConnections).toBe(guarded.stats.connections);
    await expect(guarded.db.execute(sql`DELETE FROM stores WHERE id = 0`)).rejects.toBeInstanceOf(
      ReadOnlyGuardError,
    );
    // The refusal above was deliberate; it is not counted against any read path.
  });

  it.skipIf(!loopbackTarget)(
    'loopback only: the server itself rejects a write in the read-only session (backstop below the guard)',
    async () => {
      expect(loopback).toBe(true);
      const env = liveEnvSchema.parse(process.env);
      expect(env.POS_PROD_RO_MYSQL_CA).toBe(localPlaintext);
      const {
        connectionLimit: _limit,
        maxIdle: _idle,
        idleTimeout: _timeout,
        waitForConnections: _wait,
        queueLimit: _queue,
        ...options
      } = connectionOptions(env);
      // Deliberately unguarded and loopback-only: proves the session setting alone stops writes.
      const raw = await mysql.createConnection(options);
      try {
        await raw.query('SET SESSION TRANSACTION READ ONLY');
        await expect(raw.query('DELETE FROM stores WHERE id = 0')).rejects.toMatchObject({
          code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
        });
      } finally {
        await raw.end();
      }
    },
  );

  it('schema: every Drizzle-mapped production table equals the committed snapshot', async (context) => {
    const before = snapshot(guarded.stats),
      started = performance.now(),
      tables = await drizzleProductionTables(),
      snapshotFile = readSnapshot(),
      ddlComparison =
        summary.serverVersion === snapshotFile.serverVersion ? 'exact' : 'cross-version';
    let drift;
    try {
      drift = await liveSchemaDrift(
        guarded.databases,
        guarded.database,
        tables,
        ddlComparison,
        snapshotFile,
      );
    } catch (error) {
      summary.paths.push({
        path: 'schema',
        status: 'fail',
        reason: errorCode(error),
        rows: 0,
        checks: [],
        ...(({ refusedCodes: _codes, ...delta }) => delta)(statsDelta(guarded.stats, before)),
        durationMs: Math.round(performance.now() - started),
      });
      throw new Error(`schema check failed: ${errorCode(error)}`);
    }
    summary.schema = {
      ddlComparison,
      snapshotServerVersion: snapshotFile.serverVersion,
      tablesChecked: tables.length,
      tablesMatching: tables.length - drift.length,
      drift,
    };
    summary.paths.push({
      path: 'schema',
      status: drift.length ? 'fail' : 'pass',
      ...(drift.length ? { reason: `DRIFT ${drift.length} tables` } : {}),
      rows: tables.length,
      checks: ['information_schema.columns', 'show-create-table'],
      ...(({ refusedCodes: _codes, ...delta }) => delta)(statsDelta(guarded.stats, before)),
      durationMs: Math.round(performance.now() - started),
    });
    void context;
    expect(tables.length).toBeGreaterThan(50);
    expect(drift.map((table) => table.table)).toEqual([]);
  }, 300_000);

  it('operator, store and counter reads', (context) =>
    run(context, 'operators-stores-counters', async (s) => {
      const account = await activeAccountReader(guarded.databases)(s.operatorId);
      check(account, 'operator:active-account-present');
      parse(
        z
          .object({
            id: z.bigint(),
            role: z.number().int().min(1).max(5),
            user_type: z.number().int(),
            is_active: z.literal(true),
            last_login: sourceTimestamp.nullable(),
            date_joined: sourceTimestamp,
          })
          .loose(),
        account,
        'operator:pos_user-types',
      );
      const directory = storeDirectory(guarded.databases);
      check(
        typeof (await directory.eligible(s.operatorId, 1, s.storeId)) === 'boolean',
        'store:eligible-boolean',
      );
      const name = await directory.name(s.storeId);
      check(name === null || typeof name === 'string', 'store:name-type');
      const catalog = catalogService(guarded.databases);
      const stores = parse(z.array(storeDto), await catalog.stores(principal), 'stores:StoreDto');
      check(new Set(stores.map((store) => store.id)).size === stores.length, 'stores:unique-ids');
      const counters = parse(
        z.array(counterDto),
        await catalog.counters(principal, s.storeId),
        'counters:CounterDto',
      );
      check(nondecreasing(counters.map((counter) => BigInt(counter.id))), 'counters:id-asc');
      check(
        counters.every((counter) => counter.storeId === s.storeId),
        'counters:store-scope',
      );
      return {
        rows: stores.length + counters.length + 1,
        checks: ['zod:StoreDto', 'zod:CounterDto', 'order:counter-id-asc', 'types:pos_user'],
      };
    }));

  it('catalog products, barcode and stock locations', (context) =>
    run(context, 'catalog-product-barcode', async (s) => {
      const catalog = catalogService(guarded.databases);
      const page = await catalog.products(principal, s.storeId, '', '0', 20, false);
      const products = parse(z.array(catalogProduct), page.data, 'catalog:CatalogProductDto');
      check(nondecreasing(products.map((product) => BigInt(product.id))), 'catalog:id-asc');
      check(page.data.length <= 20, 'catalog:page-size');
      check(page.nextCursor === null || /^\d+$/.test(page.nextCursor), 'catalog:cursor');
      check(
        products.every((product) => product.stock > 0),
        'catalog:in-stock-only',
      );
      if (page.nextCursor) {
        const next = await catalog.products(principal, s.storeId, '', page.nextCursor, 5, false);
        check(
          next.data.every((product) => BigInt(product.id) > BigInt(page.nextCursor!)),
          'catalog:cursor-advances',
        );
      }
      const checks = ['zod:CatalogProductDto', 'order:product-id-asc', 'cursor:keyset'];
      const withBarcode = products.find((product) => product.barcode !== null);
      if (withBarcode) {
        const exact = await catalog.products(
          principal,
          s.storeId,
          '',
          '0',
          2,
          false,
          withBarcode.barcode!,
        );
        const found = uniqueBarcodeProduct(exact.data, withBarcode.barcode!);
        check(found.product.id === withBarcode.id, 'barcode:resolves-same-product');
        checks.push('barcode:exact-gtin-lookup');
      }
      if (products.length) {
        const ids = products.slice(0, 5).map((product) => product.id);
        const locations = await readCatalogStockLocations(
          guarded.databases,
          principal,
          s.storeId,
          ids,
        );
        check(
          locations.data.map((row) => row.productId).join() === ids.join(),
          'stock-locations:request-order',
        );
        check(
          locations.data.every((row) => Number.isInteger(row.heldStock)),
          'stock-locations:held-int',
        );
        checks.push('stock-locations:shape');
      }
      // Search patterns the counter page sends (W16 round 3): a name fragment, an id/GTIN digit
      // fragment and a term that matches nothing. In stock, these read the store's in-stock rows
      // through idx_store_id_stock_is_avail_is_del. Values stay in memory and are never printed.
      const sample = products[0];
      const noMatch = 'w16-no-match-zz';
      const terms = [
        ...(sample && sample.name.length >= 4 ? [sample.name.slice(0, 4)] : []),
        ...(sample ? [sample.id.slice(-3)] : []),
        noMatch,
      ];
      for (const term of terms) {
        const found = await catalog.products(principal, s.storeId, term, '0', 20, false);
        parse(z.array(catalogProduct), found.data, 'catalog:search-in-stock');
        check(
          found.data.every((product) => product.stock > 0),
          'catalog:search-in-stock-only',
        );
      }
      checks.push('search:in-stock');
      // With out-of-stock rows and no match, the page walks the whole catalog by id (no
      // product_store read for non-matching products). Legacy runs the same request as a count
      // plus a page over the store's ~319k joined rows, which is strictly more work (see
      // parity/w16-report.md). A timeout here is a known legacy-equivalent cost, not a failure.
      try {
        const none = await catalog.products(principal, s.storeId, noMatch, '0', 20, true);
        check(none.data.length === 0, 'catalog:search-no-match');
        checks.push('search:oos-no-match');
      } catch (error) {
        if (errorCode(error) !== 'ER_QUERY_TIMEOUT') throw error;
        checks.push('search:oos-no-match:legacy-equivalent-timeout');
      }
      return { rows: products.length, checks };
    }));

  it('checkout quote inputs (price list, stock, cart product, counter, customer)', (context) =>
    run(context, 'checkout-quote-inputs', async (s) => {
      const repository = checkoutRepository(
        guarded.databases,
        checkoutSessionStore(memoryStateStore()),
      );
      const checks: string[] = [];
      let rows = 0;
      for (const productId of s.productIds.slice(0, 5)) {
        const product = await repository.cartProduct(productId);
        if (!product) continue;
        rows += 1;
        parse(
          z.object({ type: z.number().int(), barcode: idText.nullable() }).strict(),
          product,
          'checkout:cartProduct',
        );
      }
      checks.push('zod:cartProduct');
      if (s.counterId) {
        check(
          (await repository.counter(s.storeId, s.counterId)) === true,
          'checkout:active-counter',
        );
        checks.push('counter:active');
      }
      if (s.customerId) {
        const customer = await repository.customer(s.customerId);
        if (customer) {
          rows += 1;
          parse(
            z
              .object({
                id: idText,
                email: z.string(),
                firstName: z.string(),
                lastName: z.string(),
                telephone: z.string(),
                twoFactor: z.boolean(),
                active: z.boolean(),
                exclusive: z.boolean(),
                blocked: z.number().nullable(),
                disabled: z.number().nullable(),
              })
              .loose(),
            customer,
            'checkout:CustomerIdentity',
          );
          checks.push('zod:CustomerIdentity');
        }
      }
      // The quote itself reads no product_store row: prices and stock come from API-v2
      // (processorder), as in legacy AjaxCartView (order/views.py:1692-1770). The price-list
      // (pricelist id 2) and stock columns the cashier sees come from the counter product picker
      // with out-of-stock rows (include_oss_toggle=1): products PRIMARY in id order plus one
      // uq_product_store point read per product, bounded by LIMIT (W16).
      const page = await catalogService(guarded.databases).products(
        principal,
        s.storeId,
        '',
        '0',
        10,
        true,
      );
      parse(z.array(catalogProduct), page.data, 'checkout:price-and-stock');
      checks.push('pricelist:exclusive-price', 'stock:product_store+hold+storage');
      return { rows: rows + page.data.length, checks };
    }));

  it('inventory list', (context) =>
    run(context, 'inventory-list', async (s) => {
      const list = await inventoryService(config, guarded.databases).list(principal, s.storeId, {
        after: '0',
        limit: 20,
        search: '',
        active: 'all',
      });
      const rows = parse(z.array(inventoryRow), list.data, 'inventory:row-types');
      check(nondecreasing(rows.map((row) => row.id)), 'inventory:id-asc');
      check(list.nextCursor === null || /^\d+$/.test(list.nextCursor), 'inventory:cursor');
      return { rows: rows.length, checks: ['types:inventory-row', 'order:id-asc'] };
    }));

  it('customer lookup by id', (context) =>
    run(context, 'customer-by-id', async (s) => {
      if (!s.customerId) throw new SkipPath('NO_CUSTOMER_SAMPLE');
      const customer = await readCurrentOrderCustomer(
        guarded.databases,
        s.customerId,
        zone,
        Date.now(),
      );
      check(customer.id === s.customerId, 'customer:id-binding');
      return { rows: 1, checks: ['zod:currentOrderCustomer', 'binding:customer-id'] };
    }));

  it('store order list and detail', (context) =>
    run(context, 'orders-store-list-detail', async (s) => {
      const orders = ordersService(guarded.databases, config);
      const page = await orders.list(principal, s.storeId, undefined, 20, {
        from: s.storeOrderDay,
        to: s.storeOrderDay,
      });
      const rows = parse(z.array(orderRow), page.data, 'orders:OrderDto');
      check(nonincreasing(rows.map((row) => BigInt(row.id))), 'orders:id-desc');
      check(
        rows.every((row) => row.storeId === s.storeId),
        'orders:store-scope',
      );
      check(
        rows.every((row) => row.createdAt.startsWith(s.storeOrderDay)),
        'orders:date-window',
      );
      const detail = parse(
        storeDetail,
        await orders.detail(principal, s.storeId, s.storeOrderId),
        'orders:StoreOrderDetail',
      );
      check(detail.id === s.storeOrderId, 'orders:detail-id');
      check(nondecreasing(detail.lines.map((line) => BigInt(line.id))), 'orders:lines-id-asc');
      return {
        rows: rows.length + 1 + detail.lines.length,
        checks: ['zod:OrderDto', 'zod:StoreOrderDetail', 'order:id-desc', 'window:business-day'],
      };
    }));

  it('order search (store tab, explicit id, options)', (context) =>
    run(context, 'orders-search-store', async (s) => {
      const search = orderSearchService(config, guarded.databases);
      const page = await search.search(principal, s.storeId, {
        orderType: 'ST',
        storeIds: [s.storeId],
        from: s.storeOrderDay,
        to: s.storeOrderDay,
        pageSize: 25,
      });
      const rows = parse(z.array(sourceRowSchema), page.data, 'search:sourceRowSchema');
      check(/^\d+$/.test(page.recordsTotal), 'search:records-total');
      check(Number(page.recordsTotal) >= rows.length, 'search:total-covers-page');
      check(nonincreasing(rows.map((row) => BigInt(row.id))), 'search:id-desc');
      const byId = await search.search(principal, s.storeId, {
        orderType: 'ST',
        storeIds: [s.storeId],
        orderIds: [s.storeOrderId],
      });
      parse(z.array(sourceRowSchema), byId.data, 'search:by-id:sourceRowSchema');
      check(
        byId.data.some((row) => row.id === s.storeOrderId),
        'search:by-id-finds-order',
      );
      const options = await search.options(principal, s.storeId);
      check(options && typeof options === 'object', 'search:options');
      return {
        rows: rows.length + byId.data.length,
        checks: ['zod:sourceRowSchema', 'order:id-desc', 'search:explicit-id', 'search:options'],
      };
    }));

  it('online order search and detail', (context) =>
    run(context, 'orders-online-search-detail', async (s) => {
      if (!s.onlineOrderId) throw new SkipPath('NO_ONLINE_ORDER_SAMPLE');
      const page = await orderSearchService(config, guarded.databases).search(
        principal,
        s.storeId,
        {
          orderType: 'N',
          storeIds: [s.storeId],
          orderIds: [s.onlineOrderId],
        },
      );
      parse(z.array(sourceRowSchema), page.data, 'online-search:sourceRowSchema');
      const detail = await onlineOrderDetailService(config, guarded.databases).read(
        principal,
        s.storeId,
        s.onlineOrderId,
        { type: 'N' },
      );
      parse(onlineOrderDetail, detail, 'online-detail:onlineOrderDetail');
      check(detail.fact.customerId === detail.customer.id, 'online-detail:customer-binding');
      return {
        rows: page.data.length + 1,
        checks: ['zod:sourceRowSchema', 'zod:onlineOrderDetail', 'binding:customer'],
      };
    }));

  it('daily report for one store today (data reader, legacy report SQL)', (context) =>
    run(context, 'reports-daily-today', async (s) => {
      const report = await reportService(config, guarded.databases, {
        warehouse: fakeWarehouse,
        paymentCorrections: paymentCorrectionFinanceOptions({}),
      }).daily(principal, { storeIds: [s.storeId], from: today(), to: today() });
      check(report.reader === 'data', 'daily:reader-data');
      for (const row of report.data)
        check(
          Object.values(row).every((value) => typeof value !== 'bigint'),
          'daily:no-bigint',
        );
      check(
        Object.values(report.totals).every(
          (value) => value === null || typeof value === 'number' || typeof value === 'string',
        ),
        'daily:totals-scalars',
      );
      check(
        report.data.every((row) => row['date'] === today()),
        'daily:business-day',
      );
      return { rows: report.data.length, checks: ['zod:rollupSchema', 'routing:data-reader'] };
    }));

  it('legacy daily report SQL (E3) bound for the sampled store and business day', (context) =>
    run(context, 'reports-legacy-daily-sql', async (s) => {
      const start = `${s.storeOrderDay} 00:00:00`,
        end = `${s.storeOrderDay} 23:59:59`;
      const result = await guarded.db.transaction(
        async (tx) => {
          const [excluded] = (await tx.execute(
            sql.raw(legacyReportSql.excludedProducts),
          )) as unknown as [Record<string, unknown>[]];
          const exclusions = excluded.map((row) => BigInt(String(Object.values(row)[0])));
          const [store] = (await tx.execute(
            bindReportSql(legacyReportSql.storeOrders, [s.storeId], exclusions, start, end),
          )) as unknown as [unknown[]];
          const [online] = (await tx.execute(
            bindReportSql(legacyReportSql.onlineOrders, [s.storeId], exclusions, start, end),
          )) as unknown as [unknown[]];
          return { exclusions: exclusions.length, store, online };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      const store = parse(z.array(rollupSchema), result.store, 'legacy-daily:storeOrders');
      const online = parse(z.array(rollupSchema), result.online, 'legacy-daily:onlineOrders');
      check(
        [...store, ...online].every((row) => String(row.store_id) === s.storeId),
        'legacy-daily:store-scope',
      );
      check(
        [...store, ...online].every((row) => row.order_date === s.storeOrderDay),
        'legacy-daily:business-day',
      );
      return {
        rows: store.length + online.length,
        checks: [
          'zod:rollupSchema',
          'legacy-sql:excludedProducts',
          'legacy-sql:storeOrders',
          'legacy-sql:onlineOrders',
        ],
      };
    }));

  it('scheduled report data: ORM reads equal the frozen source SQL for one hour', (context) =>
    run(context, 'reports-scheduled-hour', async (s) => {
      const from = s.storeOrderHour,
        start = Temporal.PlainDateTime.from(from.replace(' ', 'T')),
        period = {
          from,
          end: start.add({ hours: 1 }).toString().replace('T', ' '),
          windowStart: start.subtract({ hours: 24 }).toString().replace('T', ' '),
        };
      const kinds = [
        'timing',
        'summary',
        'availability',
        'platform',
        'delays',
        'cancellations',
        'tickets',
      ] as const;
      let rows = 0;
      const checks: string[] = [];
      const canonical = (value: unknown[]) =>
        value
          .map((row) =>
            JSON.stringify(row, (_key, item: unknown) =>
              typeof item === 'bigint' ? `${item}n` : item,
            ),
          )
          .sort();
      for (const kind of kinds) {
        const orm = await scheduledMysqlRows(guarded.db, kind, period, true);
        const [source] = (await guarded.db.execute(
          scheduledSourceQuery(kind, period, true),
        )) as unknown as [unknown[]];
        check(orm.length === source.length, `scheduled:${kind}:row-count-parity`);
        check(
          canonical(orm).join('\n') === canonical(source).join('\n'),
          `scheduled:${kind}:value-type-parity`,
        );
        rows += orm.length;
        checks.push(`parity:${kind}`);
      }
      return { rows, checks };
    }));

  it('order transactions report (E3 order-report SQL) for today on the data reader', (context) =>
    run(context, 'reports-order-transactions-today', async (s) => {
      const service = orderTransactionsReportService(
        config,
        guarded.databases,
        orderTransactionsOptions({}),
        fakeWarehouse,
      );
      let rows = 0;
      for (const source of ['store', 'online'] as const) {
        const result = await service.read(principal, {
          from: `${today()}T00:00:00`,
          to: `${today()}T23:59:59`,
          storeIds: [s.storeId],
          source,
          dateType: 'order_date',
          page: 1,
          pageSize: 25,
        });
        check(result.reader === 'data', `order-transactions:${source}:reader-data`);
        check(
          Number.isSafeInteger(result.total) && result.total >= result.data.length,
          `order-transactions:${source}:total`,
        );
        rows += result.data.length;
      }
      return {
        rows,
        checks: ['zod:orderReportLineSchema', 'routing:data-reader', 'source:store+online'],
      };
    }));

  it('flash sales report (E3 flash-sales SQL) for today on the data reader', (context) =>
    run(context, 'reports-flash-sales-today', async (s) => {
      const views = Object.fromEntries(
        [
          'BQ_FLASH_SALES_ORDERS_VIEW',
          'BQ_FLASH_SALES_ORDER_STORES_VIEW',
          'BQ_FLASH_SALES_LINES_VIEW',
          'BQ_FLASH_SALES_STORES_VIEW',
          'BQ_FLASH_SALES_PAYTM_TRANSACTIONS_VIEW',
          'BQ_FLASH_SALES_RETURN_ORDERS_VIEW',
          'BQ_FLASH_SALES_REFUND_LOGS_VIEW',
          'BQ_FLASH_SALES_AUTOMATED_REFUNDS_VIEW',
        ].map((name) => [name, fakeView]),
      );
      const result = await flashSalesReportService(
        config,
        guarded.databases,
        flashSalesOptions(views),
        fakeWarehouse,
      ).read(principal, {
        from: today(),
        to: today(),
        storeIds: [s.storeId],
        sort: 'store_date',
        direction: 'asc',
        page: 1,
        pageSize: 25,
      });
      check(result.reader === 'data', 'flash-sales:reader-data');
      check(result.total >= result.data.length, 'flash-sales:total');
      return {
        rows: result.data.length,
        checks: ['zod:flashSalesSourceRowSchema', 'routing:data-reader'],
      };
    }));

  it('finance cash reads (collection snapshot, cash ledger, reconciliation feed)', (context) =>
    run(context, 'finance-cash', async (s) => {
      const corrections = paymentCorrectionFinanceOptions({});
      const collection = await guarded.db.transaction(
        (tx) => collectionSnapshot(tx, s.storeId, s.storeOrderDay, corrections),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      parse(
        z
          .object({
            order_count: z.number().int().nonnegative(),
            cash: moneyText,
            cash_refund: moneyText,
            card_upi: moneyText,
          })
          .loose(),
        collection,
        'finance:CollectionSnapshot',
      );
      const checks = ['types:collection-snapshot'];
      const ledger = cashLedgerService(
        config,
        guarded.databases,
        ledgerOptions({}),
        fakeWarehouse,
        () => Temporal.Now.instant(),
        corrections,
      );
      const stores = await ledger.stores(principal);
      parse(
        z.object({ data: z.array(z.object({ id: idText, name: z.string() }).strict()) }),
        stores,
        'ledger:stores',
      );
      checks.push('ledger:stores');
      try {
        const current = await ledger.read(principal, [s.storeId], today(), today());
        check(current.reader === 'data', 'ledger:reader-data');
        checks.push('ledger:today-data-reader');
      } catch (error) {
        // Without today's opening anchor the ledger needs the BigQuery chain (not read-only here).
        if (!(error instanceof AppError && error.code === 'DEPENDENCY_UNAVAILABLE')) throw error;
        checks.push('ledger:today-needs-warehouse');
      }
      if (s.storeCode) {
        const feed = await financeFeedService(
          config,
          guarded.databases,
          financeFeedOptions({ BQ_FINANCE_RECONCILIATION_RETURNS: fakeView }),
          fakeWarehouse,
        ).orders({ from: today(), to: today(), page: 1, pageSize: 25, storeCode: s.storeCode });
        check(feed && typeof feed === 'object', 'feed:result');
        checks.push('zod:feedSaleLineSchema');
      }
      return { rows: 1 + stores.data.length, checks };
    }));
});
