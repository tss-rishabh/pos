import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, gte, inArray, like, or, sql } from 'drizzle-orm';
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
import { stockChangeComment, visibilityValue } from './policies.js';
import type { AdminPage } from './service.js';
import { executeStockProcedure, type StockProcedure } from './stock-procedure.js';
import { assertCurrentInventoryAccess } from './authorization.js';
import type { ProductSynchronizer } from './product-sync.js';

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
  /** Requires writer-body parity and caller-owned transaction safety (no internal commit/session leakage). */
  procedureVerified?: boolean;
  /** Optional verified transaction-scoped implementation; tests inject isolated audit fixtures. */
  stockProcedure?: StockProcedure;
  /** Legacy `Helpers.sync_pos_product`, called inline after commit; never throws. */
  productSync?: ProductSynchronizer;
}
export function inventoryService(config: Config, db: Databases, options: InventoryOptions = {}) {
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
  const productSync: ProductSynchronizer = options.productSync ?? (async () => false);
  return {
    async list(user: Principal, storeId: string, page: AdminPage) {
      authorize(user, storeId);
      const reader = db.get('primary'),
        store = BigInt(storeId);
      // W16: choose the page of product ids first from this store's `product_store` index
      // (never a `products` PRIMARY range over the whole catalog), then read the columns and the
      // first barcode for those rows only, in the same statement.
      const selected = reader
        .select({
          id: sql<bigint>`/*+ JOIN_ORDER(product_store, products) */ ${Product.id}`.as('page_id'),
        })
        .from(ProductStore, { forceIndex: 'idx_store_id_stock_is_avail_is_del' })
        .innerJoin(Product, eq(Product.id, ProductStore.product))
        .where(
          and(
            eq(ProductStore.store, store),
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
        .limit(page.limit + 1)
        .as('inventory_page');
      // Drizzle renders a subquery's SQL field unqualified; name the derived column explicitly.
      const pageId = sql`${sql.identifier('inventory_page')}.${sql.identifier('page_id')}`;
      const rows = await reader
        .select({
          id: Product.id,
          name: Product.product,
          erpName: Product.erp_product,
          parentId: Product.parent_prod_id,
          type: Product.prod_type,
          stock: ProductStore.stock,
          available: ProductStore.is_avail,
          archived: ProductStore.is_del,
          barcode: sql<string | null>`${reader
            .select({ gtin: ProductBarcode.gtin })
            .from(ProductBarcode)
            .where(eq(ProductBarcode.product, Product.id))
            .orderBy(asc(ProductBarcode.id))
            .limit(1)}`,
        })
        .from(selected)
        .innerJoin(Product, eq(Product.id, pageId))
        .innerJoin(
          ProductStore,
          and(eq(ProductStore.product, pageId), eq(ProductStore.store, store)),
          { forceIndex: 'uq_product_store' },
        )
        .orderBy(asc(Product.id));
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
    ) {
      authorize(user, storeId);
      if (!options.procedureVerified) return unavailable('Verified inventory stock procedure');
      const result = await retryTransaction(() =>
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
          return {
            status: 'success',
            message: current
              ? 'Product stock updated for the selected store.'
              : 'Product stock created for the selected store.',
            stock,
          };
        }),
      );
      // Source `AssignProductStockView` syncs `[product_id]` after the save (`core/views.py:543,564`).
      await productSync([productId], { operatorId: user.id, storeId });
      return result;
    },
    async setVisibility(
      user: Principal,
      storeId: string,
      productId: string,
      kind: 'available' | 'listed',
      checked: boolean,
      parentProductId: string | null,
    ) {
      authorize(user, storeId);
      const result = await db.get('writer').transaction(async (transaction) => {
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
        return {
          status: 'success',
          message: 'Product data updated successfully !',
        };
      });
      // Source syncs only the selected `prod_id` after the update (`core/views.py:776`).
      await productSync([productId], { operatorId: user.id, storeId });
      return result;
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
            gte(ProductInventoryLog.created_at, dayStart),
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
  };
}
