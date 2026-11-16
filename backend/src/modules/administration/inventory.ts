import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  Product,
  ProductBarcode,
  ProductInventoryLog,
  ProductStore,
} from '../../db/legacy-schema.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { retryTransaction } from '../../db/retry.js';
import { administrationOutbox, type InventoryIntegrationEvent } from './schema.js';
import { stockChangeComment, visibilityValue } from './policies.js';
import type { AdminPage } from './service.js';
import { executeStockProcedure, type StockProcedure } from './stock-procedure.js';
import { assertCurrentInventoryAccess } from './authorization.js';

export {
  enqueueInventorySynchronization,
  enqueueSystemInventorySynchronization,
  type InventorySynchronizationInput,
  type SystemInventorySynchronizationInput,
} from './inventory-synchronization.js';
export interface InventorySynchronizationContext {
  operatorId: string;
  storeId: string;
  requestId?: string;
  /** Global catalog repair only; caller owns current authorization and durable command state. */
  troubleshoot?: boolean;
}

export interface InventoryOptions {
  /** Global catalog work has no invented store scope. */
  syncCatalogProducts?: (
    eventId: string,
    productIds: string[],
    context: { operatorId: string; importId: string; requestId?: string },
  ) => Promise<void>;
  /** Requires writer-body parity and caller-owned transaction safety (no internal commit/session leakage). */
  procedureVerified?: boolean;
  /** Optional verified transaction-scoped implementation; tests inject isolated audit fixtures. */
  stockProcedure?: StockProcedure;
  /** Implementations must deduplicate by eventId; no PII or raw payload logging. */
  syncProducts?: (
    eventId: string,
    productIds: string[],
    context: InventorySynchronizationContext,
  ) => Promise<void>;
}
export function inventoryService(config: Config, db: Databases, options: InventoryOptions = {}) {
  const now = () =>
    Temporal.Now.instant()
      .toZonedDateTimeISO('UTC')
      .toPlainDateTime()
      .toString({ smallestUnit: 'millisecond' })
      .replace('T', ' ');
  function authorize(user: Principal, storeId: string) {
    requireRole(user, [1, 2, 3]);
    requireStore(user, storeId);
    if (user.userType === 2)
      throw new AppError(
        403,
        'INVENTORY_ADMINISTRATION_DENIED',
        'Stock administration is restricted for this user type.',
      );
  }
  function integrationAvailable() {
    if (!options.syncProducts) return unavailable('Product synchronization adapter');
  }
  return {
    async list(user: Principal, storeId: string, page: AdminPage) {
      authorize(user, storeId);
      const rows = await db
        .get('primary')
        .select({
          id: Product.id,
          name: Product.product,
          erpName: Product.erp_product,
          parentId: Product.parent_prod_id,
          type: Product.prod_type,
          stock: ProductStore.stock,
          available: ProductStore.is_avail,
          archived: ProductStore.is_del,
          barcode: sql<
            string | null
          >`(select ${ProductBarcode.gtin} from ${ProductBarcode} where ${ProductBarcode.product}=${Product.id} order by ${ProductBarcode.id} asc limit 1)`,
        })
        .from(ProductStore)
        .innerJoin(Product, eq(Product.id, ProductStore.product))
        .where(
          and(
            eq(ProductStore.store, BigInt(storeId)),
            gt(Product.id, BigInt(page.after)),
            page.active === 'all' ? undefined : eq(ProductStore.is_del, page.active === 'false'),
            page.search
              ? or(
                  like(Product.product, `%${page.search.replace(/[\\%_]/g, '\\$&')}%`),
                  eq(Product.id, /^\d+$/.test(page.search) ? BigInt(page.search) : 0n),
                )
              : undefined,
          ),
        )
        .orderBy(asc(Product.id))
        .limit(page.limit + 1);
      return {
        data: rows.slice(0, page.limit),
        nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!.id) : null,
      };
    },
    async setStock(
      user: Principal,
      storeId: string,
      productId: string,
      stock: number,
      expectedStock: number,
      requestId: string,
    ) {
      authorize(user, storeId);
      integrationAvailable();
      if (!options.procedureVerified) return unavailable('Verified inventory stock procedure');
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentInventoryAccess(transaction, user.id, storeId);
          const [product] = await transaction
            .select({ id: Product.id, parentId: Product.parent_prod_id, type: Product.prod_type })
            .from(Product)
            .where(eq(Product.id, BigInt(productId)))
            .limit(1)
            .for('update');
          if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
          if (product.type === 3n)
            throw new AppError(
              409,
              'CONFIGURABLE_PARENT_STOCK',
              'Parent configurable product cannot be saved.',
            );
          const [current] = await transaction
            .select()
            .from(ProductStore)
            .where(
              and(
                eq(ProductStore.store, BigInt(storeId)),
                eq(ProductStore.product, BigInt(productId)),
              ),
            )
            .limit(1)
            .for('update');
          if ((current?.stock || 0) !== expectedStock)
            throw new AppError(
              409,
              'STOCK_CONFLICT',
              'Stock changed since you opened this product. Refresh before saving.',
            );
          if (!current) {
            if (product.parentId > 0n)
              await transaction
                .insert(ProductStore)
                .values({
                  product: product.parentId,
                  store: BigInt(storeId),
                  stock: 0,
                  is_avail: true,
                  is_del: false,
                })
                .onDuplicateKeyUpdate({ set: { product: product.parentId } });
            await transaction.insert(ProductStore).values({
              product: product.id,
              store: BigInt(storeId),
              stock: 0,
              is_avail: true,
              is_del: false,
            });
          }
          if (!current || stock !== current.stock) {
            // Source: Helpers.sync_pos_inventory -> pos_stock_syncer. Its audited
            // procedure remains authoritative for inventory-history side effects.
            await (options.stockProcedure || executeStockProcedure)(transaction, {
              storeId,
              productId: String(product.id),
              stock,
              operatorId: user.id,
              comment: !current
                ? 'Product inventory added from admin panel.'
                : stockChangeComment(current.stock, stock),
            });
            await transaction
              .update(ProductStore)
              .set({ stock })
              .where(
                and(eq(ProductStore.store, BigInt(storeId)), eq(ProductStore.product, product.id)),
              );
          }
          const eventId = crypto.randomUUID();
          const payload: InventoryIntegrationEvent = {
            kind: 'product.stock.changed',
            storeId,
            productId,
            stockBefore: current?.stock || 0,
            stockAfter: stock,
            actorId: user.id,
            requestId,
          };
          await transaction.insert(administrationOutbox).values({
            id: eventId,
            kind: payload.kind,
            payload,
            attempts: 0,
            createdAt: now(),
            deliveredAt: null,
          });
          return {
            status: 'success',
            message: current
              ? 'Product stock updated for the selected store.'
              : 'Product stock created for the selected store.',
            stock,
            synchronization: { eventId, state: 'pending', requestId },
          };
        }),
      );
    },
    async setVisibility(
      user: Principal,
      storeId: string,
      productId: string,
      kind: 'available' | 'listed',
      checked: boolean,
      parentProductId: string | null,
      requestId: string,
    ) {
      authorize(user, storeId);
      integrationAvailable();
      return db.get('writer').transaction(async (transaction) => {
        await assertCurrentInventoryAccess(transaction, user.id, storeId);
        const [product] = await transaction
          .select({ id: Product.id, parentId: Product.parent_prod_id })
          .from(Product)
          .where(eq(Product.id, BigInt(productId)))
          .limit(1);
        if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
        if (
          parentProductId &&
          product.id !== BigInt(parentProductId) &&
          product.parentId !== BigInt(parentProductId)
        )
          throw new AppError(
            400,
            'PRODUCT_FAMILY_MISMATCH',
            'Parent product does not match the selected product.',
          );
        const affected = parentProductId
          ? await transaction
              .select({ id: Product.id })
              .from(Product)
              .where(
                or(
                  eq(Product.parent_prod_id, BigInt(parentProductId)),
                  eq(Product.id, BigInt(parentProductId)),
                ),
              )
              .orderBy(asc(Product.id))
              .limit(1001)
          : [{ id: product.id }];
        if (affected.length > 1000) return unavailable('Reconciled product family');
        const ids = affected.map((row) => row.id);
        if (ids.length)
          await transaction
            .update(ProductStore)
            .set(
              kind === 'available'
                ? { is_avail: visibilityValue(kind, checked) }
                : { is_del: visibilityValue(kind, checked) },
            )
            .where(
              and(eq(ProductStore.store, BigInt(storeId)), inArray(ProductStore.product, ids)),
            );
        const eventId = crypto.randomUUID(),
          payload: InventoryIntegrationEvent = {
            kind: 'product.visibility.changed',
            storeId,
            productIds: ids.map(String),
            actorId: user.id,
            requestId,
          };
        await transaction.insert(administrationOutbox).values({
          id: eventId,
          kind: payload.kind,
          payload,
          attempts: 0,
          createdAt: now(),
          deliveredAt: null,
        });
        return {
          status: 'success',
          message: 'Product data updated successfully !',
          synchronization: { eventId, state: 'pending', requestId },
        };
      });
    },
    async productLogs(
      user: Principal,
      storeId: string,
      productId: string,
      after: string,
      limit: number,
    ) {
      authorize(user, storeId);
      const dayStart = Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .startOfDay()
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' ');
      const rows = await db
        .get('data')
        .select({
          id: ProductInventoryLog.id,
          before: ProductInventoryLog.stock_before,
          after: ProductInventoryLog.stock_after,
          type: ProductInventoryLog.type,
          operatorId: ProductInventoryLog.pos_user_id,
          createdAt: ProductInventoryLog.created_at,
          comment: ProductInventoryLog.comment,
        })
        .from(ProductInventoryLog)
        .where(
          and(
            eq(ProductInventoryLog.store_id, BigInt(storeId)),
            eq(ProductInventoryLog.product_id, BigInt(productId)),
            gt(ProductInventoryLog.id, BigInt(after)),
            sql`${ProductInventoryLog.created_at}>=${dayStart}`,
          ),
        )
        .orderBy(asc(ProductInventoryLog.id))
        .limit(limit + 1);
      return {
        data: rows.slice(0, limit),
        nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null,
        scope: 'current-business-day',
      };
    },
    async dispatchPending(limit = 25) {
      if (!options.syncProducts && !options.syncCatalogProducts)
        return unavailable('Product synchronization adapter');
      let delivered = 0;
      for (let index = 0; index < limit; index++) {
        const success = await db.get('writer').transaction(async (transaction) => {
          const [row] = await transaction
            .select()
            .from(administrationOutbox)
            .where(
              and(
                isNull(administrationOutbox.deliveredAt),
                sql`${administrationOutbox.attempts}<10`,
                options.syncProducts && options.syncCatalogProducts
                  ? undefined
                  : options.syncCatalogProducts
                    ? eq(administrationOutbox.kind, 'product.catalog.synchronization')
                    : ne(administrationOutbox.kind, 'product.catalog.synchronization'),
              ),
            )
            .orderBy(asc(administrationOutbox.attempts), asc(administrationOutbox.createdAt))
            .limit(1)
            .for('update', { skipLocked: true });
          if (!row) return false;
          await transaction
            .update(administrationOutbox)
            .set({ attempts: row.attempts + 1 })
            .where(eq(administrationOutbox.id, row.id));
          const ids =
            row.payload.kind === 'product.stock.changed'
              ? [row.payload.productId]
              : row.payload.productIds;
          try {
            if (row.payload.kind === 'product.catalog.synchronization') {
              if (!options.syncCatalogProducts) return false;
              await options.syncCatalogProducts(row.id, ids, {
                operatorId: row.payload.actorId,
                importId: row.payload.importId,
                ...(row.payload.requestId ? { requestId: row.payload.requestId } : {}),
              });
            } else
              await options.syncProducts!(row.id, ids, {
                operatorId: row.payload.actorId,
                storeId: row.payload.storeId,
                ...(row.payload.requestId ? { requestId: row.payload.requestId } : {}),
              });
          } catch {
            return false;
          }
          await transaction
            .update(administrationOutbox)
            .set({ deliveredAt: now() })
            .where(eq(administrationOutbox.id, row.id));
          return true;
        });
        if (!success) break;
        delivered++;
      }
      return delivered;
    },
  };
}
