import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, exists, gt, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  CsvUpload,
  HoldStockStore,
  PosHoldStockLog,
  Product,
  ProductStore,
  Store,
  UserStore,
} from '../../db/legacy-schema.js';
import { identifier } from '../../domain/validation.js';
import type { JobArgs, JobContext, JobHandler } from '../../jobs/contract.js';
import { withEphemeralLock, type EphemeralStore } from '../../jobs/ephemeral.js';
import type { JobLogger } from '../../jobs/runtime.js';
import type { AdministrationTransaction } from './checkins.js';
import {
  PythonError,
  importMessages,
  importProgress,
  importProgressKey,
  importProgressTtlSeconds,
  pythonDictRows,
  pythonInt,
  pythonJsonDumps,
  requiredColumns,
  type CsvRecord,
  type FailedRecord,
  type ImportProgress,
  type UploadType,
} from './import-domain.js';
import type { CsvUploadStorage } from './import-storage.js';
import type { ProductSynchronizer } from './product-sync.js';
import type { StockProcedure } from './stock-procedure.js';

/** Celery args of `parse_csv_product_store` / `parse_csv_product_stock` (`core/tasks.py:28-48`). */
const importArgs = z
  .object({
    upload_id: identifier,
    user_id: identifier,
    role_id: z.union([
      z.number().int(),
      z
        .string()
        .regex(/^-?\d{1,9}$/)
        .transform(Number),
    ]),
  })
  .strict();

export interface InventoryImportJobDependencies {
  config: Pick<Config, 'BUSINESS_TIMEZONE'>;
  db: Databases;
  ephemeral: EphemeralStore;
  storage: CsvUploadStorage | undefined;
  /** Source `tss.pos_stock_syncer` (`GenericHelper.sync_pos_inventory`). */
  stockProcedure: StockProcedure;
  productSync: ProductSynchronizer;
  log: JobLogger;
}

const lockMs = 15 * 60 * 1000;
const int64 = (value: bigint) => value >= -(2n ** 63n) && value < 2n ** 63n;
const otherError = (error: unknown) =>
  error instanceof PythonError ? error.message : 'Unexpected error while processing the record.';

interface RecordOutcome {
  /** Each entry is appended to `failed_data`; the same entry may appear twice, as the source. */
  failed: FailedRecord[];
  /** Source appends `product_id` when the record ended without a failure. */
  productId: string | null;
  inserts: [string, string][];
  /** Unhold: legacy `inward_product_to_store` syncs these products right after the record. */
  syncNow: string[];
}
interface ImportScope {
  uploadId: string;
  userId: string;
  roleId: number;
  activeStores: ReadonlySet<string>;
  userStores: ReadonlySet<string>;
  now: string;
}

/** C1/C2 handlers: `ProductStoreParseCSV` and `ProductStockParseCSV` (`helpers/task_helpers.py:64-350`). */
export function inventoryImportJobs(deps: InventoryImportJobDependencies) {
  const { db, ephemeral, log } = deps;
  const localNow = () =>
    Temporal.Now.zonedDateTimeISO(deps.config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const event = (
    context: JobContext,
    uploadId: string,
    action: string,
    extra: Record<string, string | number | boolean | null> = {},
  ) => ({
    module: 'administration',
    resource: 'inventory-import',
    eventId: `administration.inventory-import.${action}`,
    jobId: context.jobId,
    requestId: context.requestId,
    userId: context.userId,
    uploadId,
    ...extra,
  });

  /** `GenericHelper.sync_pos_inventory`: one procedure call per existing association; the first error stops and is logged. */
  async function syncPosInventory(
    tx: AdministrationTransaction,
    scope: ImportScope,
    storeId: bigint,
    productIds: readonly bigint[],
    stock: bigint,
    comment: string,
    context: JobContext,
  ) {
    if (!storeId || !productIds.length) return;
    const rows = await tx
      .select({ product: ProductStore.product })
      .from(ProductStore)
      .where(and(eq(ProductStore.store, storeId), inArray(ProductStore.product, [...productIds])))
      .orderBy(asc(ProductStore.id));
    try {
      for (const row of rows)
        await tx.transaction((savepoint) =>
          deps.stockProcedure(savepoint, {
            storeId: String(storeId),
            productId: String(row.product),
            stock: Number(stock),
            operatorId: scope.userId,
            comment,
          }),
        );
    } catch {
      log(
        'warn',
        event(context, scope.uploadId, 'stock-procedure-failed', { storeId: String(storeId) }),
        'Stock not synced',
      );
    }
  }

  /** `Helpers.live_variant_ids(parent_id)` (`helpers/helpers.py:107-111`). */
  async function liveVariantIds(tx: AdministrationTransaction, parentId: bigint) {
    const live = alias(ProductStore, 'live_variant_store');
    const rows = await tx
      .select({ id: Product.id })
      .from(Product)
      .where(
        and(
          eq(Product.parent_prod_id, parentId),
          or(
            eq(Product.is_del, 0),
            exists(
              tx
                .select({ id: live.id })
                .from(live)
                .where(
                  and(eq(live.product, Product.id), eq(live.is_del, false), gt(live.stock, 0)),
                ),
            ),
          ),
        ),
      )
      .orderBy(asc(Product.id));
    return rows.map((row) => row.id);
  }

  /**
   * `inward_product_to_store` (`order/libs/calculations.py:286-321`): add the released quantity to
   * the store stock, re-list the product (and, for a variant, its live siblings and parent) with
   * `is_del=0, is_avail=1`, log through the stock procedure, and return the ids to sync.
   */
  async function inwardProductToStore(
    tx: AdministrationTransaction,
    scope: ImportScope,
    productId: bigint,
    storeId: bigint,
    quantity: bigint,
    context: JobContext,
  ) {
    const [current] = await tx
      .select({ stock: ProductStore.stock })
      .from(ProductStore)
      .where(and(eq(ProductStore.product, productId), eq(ProductStore.store, storeId)))
      .orderBy(asc(ProductStore.id))
      .limit(1);
    const updated = (current ? BigInt(current.stock) : 0n) + quantity;
    const [product] = await tx
      .select({ parentId: Product.parent_prod_id })
      .from(Product)
      .where(eq(Product.id, productId))
      .limit(1);
    let ids: bigint[] = [productId];
    if (product && product.parentId > 0n) {
      ids = await liveVariantIds(tx, product.parentId);
      if (!ids.includes(productId)) ids.push(productId);
      ids.push(product.parentId);
    }
    for (const id of ids) {
      const where = and(eq(ProductStore.product, id), eq(ProductStore.store, storeId));
      const [existing] = await tx
        .select({ id: ProductStore.id })
        .from(ProductStore)
        .where(where)
        .limit(1);
      if (existing)
        await tx.update(ProductStore).set({ is_del: false, is_avail: true }).where(where);
      else
        await tx
          .insert(ProductStore)
          .values({ product: id, store: storeId, stock: 0, is_avail: true, is_del: false });
    }
    await syncPosInventory(
      tx,
      scope,
      storeId,
      [productId],
      updated,
      'Product inventory added from admin panel from Hold Stock',
      context,
    );
    await tx
      .update(ProductStore)
      .set({ stock: sql`${updated}` })
      .where(and(eq(ProductStore.product, productId), eq(ProductStore.store, storeId)));
    return ids.map(String);
  }

  async function productStoreRecord(
    tx: AdministrationTransaction,
    scope: ImportScope,
    record: CsvRecord,
    context: JobContext,
  ): Promise<RecordOutcome> {
    const outcome: RecordOutcome = { failed: [], productId: null, inserts: [], syncNow: [] };
    const data = {
      SkuId: record.get('SkuId') ?? null,
      StoreId: record.get('StoreId') ?? null,
      IsActive: record.get('IsActive') ?? null,
    };
    const failure: { current: FailedRecord | null } = { current: null };
    const fail = (message: string) => {
      failure.current = { data, message };
      outcome.failed.push(failure.current);
    };
    let productId = 0n;
    try {
      productId = pythonInt(data.SkuId);
      const storeId = pythonInt(data.StoreId),
        active = pythonInt(data.IsActive);
      if (productId && storeId && (active === 0n || active === 1n)) {
        if (!scope.activeStores.has(String(storeId))) {
          fail(importMessages.invalidStore);
          return outcome;
        }
        const [product] = int64(productId)
          ? await tx
              .select({ id: Product.id, type: Product.prod_type })
              .from(Product)
              .where(and(eq(Product.id, productId), eq(Product.parent_prod_id, 0n)))
              .limit(1)
          : [];
        if (!product) {
          fail(importMessages.notParent);
          return outcome;
        }
        if (!scope.userStores.has(String(storeId)) && scope.roleId !== 1) {
          fail(importMessages.storeDenied);
          return outcome;
        }
        const withVariants = product.type === 3n ? await liveVariantIds(tx, productId) : [];
        const stockIds = [...withVariants];
        if (product.type === 1n && !withVariants.length) stockIds.push(productId);
        await syncPosInventory(
          tx,
          scope,
          storeId,
          stockIds,
          0n,
          'Product removed from store using bulk CSV upload.',
          context,
        );
        withVariants.push(productId);
        await tx
          .delete(ProductStore)
          .where(and(inArray(ProductStore.product, withVariants), eq(ProductStore.store, storeId)));
        if (active)
          for (const id of withVariants) outcome.inserts.push([String(storeId), String(id)]);
      } else fail(importMessages.missing);
    } catch (error) {
      failure.current = { data, message: importMessages.traversal, other_error: otherError(error) };
      outcome.failed.push(failure.current);
    }
    if (!failure.current) outcome.productId = String(productId);
    return outcome;
  }

  async function productStockRecord(
    tx: AdministrationTransaction,
    scope: ImportScope,
    record: CsvRecord,
    context: JobContext,
  ): Promise<RecordOutcome> {
    const outcome: RecordOutcome = { failed: [], productId: null, inserts: [], syncNow: [] };
    const data = {
      SkuId: record.get('SkuId') ?? null,
      StoreId: record.get('StoreId') ?? null,
      IsHold: record.get('IsHold') ?? null,
      'Hold/UnholdQty': record.get('Hold/UnholdQty') ?? null,
      IsAvailable: record.get('IsAvailable') ?? null,
      IsDelete: record.get('IsDelete') ?? null,
    };
    // The source keeps one dict per record and appends it again on a later exception.
    const failure: { current: FailedRecord | null } = { current: null };
    const fail = (message: string) => {
      failure.current = { data, message };
      outcome.failed.push(failure.current);
    };
    let productId = 0n;
    try {
      productId = pythonInt(data.SkuId);
      const storeId = pythonInt(data.StoreId),
        isHold = data.IsHold,
        quantity = data['Hold/UnholdQty'],
        isAvailable = data.IsAvailable,
        isDelete = data.IsDelete;
      if (productId && storeId) {
        if (!scope.activeStores.has(String(storeId))) {
          fail(importMessages.invalidStore);
          return outcome;
        }
        const [product] = int64(productId)
          ? await tx
              .select({ id: Product.id, parentId: Product.parent_prod_id })
              .from(Product)
              .where(eq(Product.id, productId))
              .limit(1)
          : [];
        if (!scope.userStores.has(String(storeId)) && scope.roleId !== 1) {
          fail(importMessages.storeDenied);
          return outcome;
        }
        const associations =
          int64(productId) && int64(storeId)
            ? await tx
                .select()
                .from(ProductStore)
                .where(and(eq(ProductStore.product, productId), eq(ProductStore.store, storeId)))
                .orderBy(asc(ProductStore.id))
            : [];
        const ps = associations[0];
        if (ps) {
          const onlyThis = and(
            eq(ProductStore.product, productId),
            eq(ProductStore.store, storeId),
          );
          // Approved divergence (user, 19 Nov 2026; AGENTS.md "Administration"): legacy
          // `if is_hold != "" and hold_unhold_qty != ""` (`helpers/task_helpers.py:241`) also
          // matches IsHold=0, so legacy holds stock for IsHold=0 and its unhold `elif`
          // (`:272-292`) is unreachable. Here a non-zero IsHold holds and IsHold=0 unholds.
          const hold = isHold !== '' && quantity !== '' ? pythonInt(isHold) : null;
          if (hold === 0n) {
            const qty = pythonInt(quantity!);
            const [held] = await tx
              .select()
              .from(HoldStockStore)
              .where(and(eq(HoldStockStore.product, productId), eq(HoldStockStore.store, storeId)))
              .orderBy(asc(HoldStockStore.id))
              .limit(1);
            if (!held || qty > BigInt(held.stock)) fail(importMessages.noUnholdStock);
            else {
              const before = BigInt(held.stock),
                after = before - qty;
              await tx
                .update(HoldStockStore)
                .set({ stock: sql`${after}` })
                .where(
                  and(eq(HoldStockStore.product, productId), eq(HoldStockStore.store, storeId)),
                );
              await tx.insert(PosHoldStockLog).values({
                product_id: productId,
                store_id: storeId,
                stock_before: String(before),
                stock_after: String(after),
                pos_user_id: BigInt(scope.userId),
                comment: 'Hold Stock inventory reduced to add into Product inventory.',
                created_at: scope.now,
                updated_at: scope.now,
              });
              outcome.syncNow = await inwardProductToStore(
                tx,
                scope,
                productId,
                storeId,
                qty,
                context,
              );
            }
          } else if (hold !== null) {
            const qty = pythonInt(quantity!),
              stock = BigInt(ps.stock);
            if (qty > stock) fail(importMessages.noHoldStock);
            else {
              const held = await tx
                .select()
                .from(HoldStockStore)
                .where(
                  and(eq(HoldStockStore.product, productId), eq(HoldStockStore.store, storeId)),
                )
                .orderBy(asc(HoldStockStore.id));
              let before: bigint, after: bigint;
              if (held[0]) {
                before = BigInt(held[0].stock);
                after = before + qty;
                await tx
                  .update(HoldStockStore)
                  .set({ stock: sql`${after}` })
                  .where(
                    and(eq(HoldStockStore.product, productId), eq(HoldStockStore.store, storeId)),
                  );
              } else {
                before = 0n;
                after = qty;
                await tx
                  .insert(HoldStockStore)
                  .values({ product: productId, store: storeId, stock: sql`${after}` });
              }
              const updated = stock - qty;
              await syncPosInventory(
                tx,
                scope,
                storeId,
                [productId],
                updated,
                'Product inventory added into hold stock.',
                context,
              );
              await tx
                .update(ProductStore)
                .set({ stock: sql`${updated}` })
                .where(onlyThis);
              await tx.insert(PosHoldStockLog).values({
                product_id: productId,
                store_id: storeId,
                stock_before: String(before),
                stock_after: String(after),
                pos_user_id: BigInt(scope.userId),
                comment: 'Hold Stock inventory added into Hold Stock from admin panel .',
                created_at: scope.now,
                updated_at: scope.now,
              });
            }
          }
          const available = isAvailable ? pythonInt(isAvailable) : ps.is_avail ? 1n : 0n;
          const deleted = isDelete ? pythonInt(isDelete) : ps.is_del ? 1n : 0n;
          await tx
            .update(ProductStore)
            .set({ is_avail: sql`${available}`, is_del: sql`${deleted}` })
            .where(onlyThis);
          if (!product)
            throw new PythonError(
              'AttributeError',
              "'NoneType' object has no attribute 'parent_prod_id'",
            );
          if (product.parentId > 0n)
            await tx
              .update(ProductStore)
              .set({ is_avail: sql`${available}`, is_del: sql`${deleted}` })
              .where(
                and(eq(ProductStore.product, product.parentId), eq(ProductStore.store, storeId)),
              );
        }
      } else fail(importMessages.missing);
    } catch (error) {
      if (failure.current) {
        failure.current.message = importMessages.traversal;
        failure.current.other_error = otherError(error);
      } else
        failure.current = {
          data,
          message: importMessages.traversal,
          other_error: otherError(error),
        };
      outcome.failed.push(failure.current);
    }
    if (!failure.current) outcome.productId = String(productId);
    return outcome;
  }

  async function closeInterrupted(uploadId: string, context: JobContext) {
    await db
      .get('writer')
      .update(CsvUpload)
      .set({ is_imported: true, message: importMessages.interrupted, updated_at: localNow() })
      .where(and(eq(CsvUpload.id, BigInt(uploadId)), eq(CsvUpload.is_imported, false)));
    log('warn', event(context, uploadId, 'interrupted'), 'Inventory import was not resumed');
  }

  async function run(type: UploadType, rawArgs: JobArgs, context: JobContext) {
    const args = importArgs.parse(rawArgs),
      uploadId = args.upload_id;
    const [upload] = await db
      .get('writer')
      .select()
      .from(CsvUpload)
      .where(eq(CsvUpload.id, BigInt(uploadId)))
      .limit(1);
    if (!upload || upload.upload_type !== type) {
      log('warn', event(context, uploadId, 'missing'), 'Inventory import upload was not found');
      return;
    }
    if (upload.is_imported) {
      log(
        'info',
        event(context, uploadId, 'already-imported'),
        'Inventory import already finished',
      );
      return;
    }
    const key = importProgressKey(uploadId),
      saved = await ephemeral.get(key);
    let progress: ImportProgress;
    try {
      if (saved === null) throw new Error('missing');
      progress = importProgress.parse(JSON.parse(saved) as unknown);
    } catch {
      // Ledger risk note: without the cursor, re-running could re-apply committed hold movements.
      return closeInterrupted(uploadId, context);
    }
    if (!deps.storage || !upload.filename) throw new Error('CSV_STORAGE_UNAVAILABLE');
    const reader = db.get('writer');
    const [userStores, activeStores] = await Promise.all([
      reader
        .select({ id: UserStore.store_id })
        .from(UserStore)
        .where(eq(UserStore.django_user_id, BigInt(args.user_id))),
      reader.select({ id: Store.id }).from(Store).where(eq(Store.is_active, true)),
    ]);
    const body = await deps.storage.read(upload.filename, context.signal);
    // Source: `l.decode('utf-8')` per line; a BOM stays part of the first header.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    const { records, error: parseError } = pythonDictRows(text);
    // Source builds `row_dict` from these keys before its `try`; a missing header ends the task
    // on the first record with the upload left unimported.
    if (records[0] && requiredColumns[type].some((column) => !records[0]!.has(column)))
      throw new PythonError('KeyError', 'Required CSV header is missing.');
    const scope: ImportScope = {
      uploadId,
      userId: args.user_id,
      roleId: args.role_id,
      userStores: new Set(userStores.map((row) => String(row.id))),
      activeStores: new Set(activeStores.map((row) => String(row.id))),
      now: localNow(),
    };
    const lockKey = `pos:lock:import:${uploadId}`;
    for (let index = progress.record; index < records.length; index++) {
      if (context.signal.aborted) {
        log(
          'info',
          event(context, uploadId, 'paused', { record: index }),
          'Inventory import paused',
        );
        return;
      }
      scope.now = localNow();
      const outcome = await db
        .get('writer')
        .transaction((tx) =>
          type === 'PRODUCT_STORE_CSV'
            ? productStoreRecord(tx, scope, records[index]!, context)
            : productStockRecord(tx, scope, records[index]!, context),
        );
      progress = {
        record: index + 1,
        failed: [...progress.failed, ...outcome.failed],
        productIds: outcome.productId
          ? [...progress.productIds, outcome.productId]
          : progress.productIds,
        inserts: [...progress.inserts, ...outcome.inserts],
      };
      await ephemeral.set(key, JSON.stringify(progress), { EX: importProgressTtlSeconds });
      await ephemeral.expire(lockKey, lockMs / 1000);
      if (outcome.syncNow.length)
        await deps.productSync(outcome.syncNow, { operatorId: args.user_id });
    }
    // Source iterates the reader inside its loop: a malformed line ends the task after the
    // records before it, leaving the upload unimported.
    if (parseError) throw parseError;
    await db.get('writer').transaction(async (tx) => {
      for (let start = 0; start < progress.inserts.length; start += 1000)
        await tx.insert(ProductStore).values(
          progress.inserts.slice(start, start + 1000).map(([store, product]) => ({
            product: BigInt(product),
            store: BigInt(store),
            stock: 0,
            is_avail: true,
            is_del: false,
          })),
        );
      await tx
        .update(CsvUpload)
        .set({
          is_imported: true,
          message:
            type === 'PRODUCT_STORE_CSV' ? importMessages.storeDone : importMessages.stockDone,
          failed_data: pythonJsonDumps(
            progress.failed.map((entry) => ({
              data: entry.data,
              message: entry.message,
              ...(entry.other_error === undefined ? {} : { other_error: entry.other_error }),
            })),
          ),
          updated_at: localNow(),
        })
        .where(eq(CsvUpload.id, BigInt(uploadId)));
    });
    await ephemeral.del(key);
    log(
      'info',
      event(context, uploadId, 'completed', {
        records: records.length,
        failedRecords: progress.failed.length,
      }),
      'Inventory import completed',
    );
    if (progress.productIds.length)
      await deps.productSync(progress.productIds, { operatorId: args.user_id });
  }

  const handler =
    (type: UploadType): JobHandler =>
    async (rawArgs, context) => {
      const uploadId = importArgs.shape.upload_id.safeParse(rawArgs.upload_id);
      const lockKey = `pos:lock:import:${uploadId.success ? uploadId.data : 'invalid'}`;
      const result = await withEphemeralLock(ephemeral, lockKey, lockMs, () =>
        run(type, rawArgs, context),
      );
      if (!result)
        log(
          'warn',
          event(context, uploadId.success ? uploadId.data : 'invalid', 'already-running'),
          'Inventory import is already running',
        );
    };
  return {
    productStore: handler('PRODUCT_STORE_CSV'),
    productStock: handler('PRODUCT_STOCK_CSV'),
  };
}
