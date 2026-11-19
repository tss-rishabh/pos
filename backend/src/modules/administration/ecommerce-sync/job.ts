import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { ProductStore, Store } from '../../../db/legacy-schema.js';
import { identifier } from '../../../domain/validation.js';
import type { JobHandler } from '../../../jobs/contract.js';
import type { JobLogger } from '../../../jobs/runtime.js';

/** Celery args of `sync_ecom_inventory(store_id)` (`core/tasks.py:181-182`). */
const syncArgs = z.object({ store_id: identifier }).strict();

/** `CALL pos_stock_syncer_bk(store, product, '<stock>', 0, 0, "Updated by System")`, bound. */
export type StockSyncerBk = (storeId: bigint, productId: bigint, stock: number) => Promise<void>;
/** `full_ecom_product_sync()`: `GET MAIN_API_V2_URL + "syncproduct"`, errors ignored. */
export type FullEcommerceSync = () => Promise<void>;

export function mysqlStockSyncerBk(db: Databases): StockSyncerBk {
  return async (storeId, productId, stock) => {
    // Source interpolates the values into the SQL string (`core/tasks.py:193`); here they are
    // bound. The quantity stays a string argument as the source's quoted literal.
    await db
      .get('writer')
      .execute(
        sql`call pos_stock_syncer_bk(${storeId}, ${productId}, ${String(stock)}, 0, 0, ${'Updated by System'})`,
      );
  };
}

export function httpFullEcommerceSync(
  mainApiV2Url: string | undefined,
  fetcher: typeof fetch = fetch,
  timeoutMs = 30_000,
): FullEcommerceSync {
  return async () => {
    try {
      if (!mainApiV2Url) return;
      const response = await fetcher(new URL(mainApiV2Url + 'syncproduct'), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
    } catch {
      // Source: `except: pass` (`core/tasks.py:201-206`).
    }
  };
}

/**
 * C10 `core.tasks.sync_ecom_inventory` (`core/tasks.py:181-199`): for every `product_store` row
 * of the active store with `stock > ecom_threshold`, call the backup stock syncer, then request the
 * full ecommerce product sync. Any failure stops the run and is only logged, as the source.
 */
export function ecommerceInventoryJob(deps: {
  db: Databases;
  syncerBk: StockSyncerBk;
  fullSync: FullEcommerceSync;
  log: JobLogger;
}): JobHandler {
  return async (rawArgs, context) => {
    const event = {
      module: 'administration',
      resource: 'ecommerce-inventory-sync',
      jobId: context.jobId,
      requestId: context.requestId,
      userId: context.userId,
    };
    let storeId = 'invalid';
    try {
      const args = syncArgs.parse(rawArgs);
      storeId = args.store_id;
      const reader = deps.db.get('writer');
      const [store] = await reader
        .select({ threshold: Store.ecom_threshold })
        .from(Store)
        .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
        .limit(1);
      if (!store) throw new Error("'NoneType' object has no attribute 'ecom_threshold'");
      const rows = await reader
        .select({ product: ProductStore.product, stock: ProductStore.stock })
        .from(ProductStore)
        .where(
          and(eq(ProductStore.store, BigInt(storeId)), gt(ProductStore.stock, store.threshold)),
        )
        .orderBy(asc(ProductStore.id));
      for (const row of rows) await deps.syncerBk(BigInt(storeId), row.product, row.stock);
      await deps.fullSync();
      deps.log(
        'info',
        {
          ...event,
          eventId: 'administration.ecommerce-inventory-sync.completed',
          storeId,
          products: rows.length,
        },
        'Ecommerce inventory synced',
      );
    } catch {
      deps.log(
        'error',
        { ...event, eventId: 'administration.ecommerce-inventory-sync.failed', storeId },
        'Stock not synced',
      );
    }
  };
}
