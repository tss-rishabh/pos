import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { Databases } from '../../db/pools.js';
import { Product, ProductStore, Store } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { assertCurrentStoreAccess } from '../administration/authorization.js';

/** Source AjaxTroubleshootInventoryView, with one bounded anti-join instead of nested IN scans. */
export function inventoryAssociationService(db: Databases) {
  return {
    async ensureParents(user: Principal, storeId: string, after = '0', limit = 500) {
      requireRole(user, [1, 2, 3, 4]);
      requireStore(user, storeId);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 2000 ||
        !/^\d+$/.test(after) ||
        BigInt(after) > 18_446_744_073_709_551_615n
      )
        throw new AppError(400, 'INVALID_REPAIR_BATCH', 'Use a valid repair batch and cursor.');
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3, 4]);
          const [store] = await tx
            .select({ id: Store.id })
            .from(Store)
            .where(eq(Store.id, BigInt(storeId)))
            .for('update');
          if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found.');
          const child = alias(Product, 'repair_child'),
            childStock = alias(ProductStore, 'repair_child_stock'),
            parentStock = alias(ProductStore, 'repair_parent_stock');
          const parents = await tx
              .selectDistinct({ id: Product.id })
              .from(Product)
              .innerJoin(child, eq(child.parent_prod_id, Product.id))
              .innerJoin(
                childStock,
                and(eq(childStock.product, child.id), eq(childStock.store, BigInt(storeId))),
              )
              .leftJoin(
                parentStock,
                and(eq(parentStock.product, Product.id), eq(parentStock.store, BigInt(storeId))),
              )
              .where(
                and(eq(child.prod_type, 1n), isNull(parentStock.id), gt(Product.id, BigInt(after))),
              )
              .orderBy(asc(Product.id))
              .limit(limit + 1),
            selected = parents.slice(0, limit);
          if (selected.length)
            await tx
              .insert(ProductStore)
              .values(
                selected.map((parent) => ({
                  product: parent.id,
                  store: BigInt(storeId),
                  stock: 0,
                  is_avail: true,
                  is_del: false,
                })),
              )
              .onDuplicateKeyUpdate({ set: { product: sql`${ProductStore.product}` } });
          return {
            storeId,
            ensuredParentIds: selected.map((parent) => String(parent.id)),
            hasMore: parents.length > limit,
            nextCursor: parents.length > limit ? String(selected.at(-1)!.id) : null,
            message: 'Parent product associations are available for this store.',
          };
        }),
      );
    },
  };
}
