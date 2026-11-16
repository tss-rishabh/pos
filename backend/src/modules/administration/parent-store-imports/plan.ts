import { and, asc, eq, exists, gt, inArray, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import type { Databases } from '../../../db/pools.js';
import { Product, ProductStore } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../checkins.js';
import type { ParentStoreImportCommand } from './types.js';
type Reader = Pick<ReturnType<Databases['get']>, 'select'>;
export function liveParentVariantPredicate(reader: Reader) {
  const live = alias(ProductStore, 'parent_import_live_stock');
  return or(
    eq(Product.is_del, 0),
    exists(
      reader
        .select({ id: live.id })
        .from(live)
        .where(and(eq(live.product, Product.id), eq(live.is_del, false), gt(live.stock, 0))),
    ),
  );
}
export interface ParentStorePlan {
  productId: string;
  storeId: string;
  active: boolean;
  familyIds: string[];
  resetIds: string[];
  existing: {
    id: bigint;
    productId: bigint;
    stock: number;
    available: boolean;
    archived: boolean;
  }[];
}
/** Writer callers already hold current operator/assignment and target Store locks. */
export async function parentStorePlan(
  tx: AdministrationTransaction,
  command: ParentStoreImportCommand,
): Promise<ParentStorePlan> {
  const [parent] = await tx
    .select({ id: Product.id, type: Product.prod_type, parentId: Product.parent_prod_id })
    .from(Product)
    .where(eq(Product.id, BigInt(command.productId)))
    .limit(1)
    .for('update');
  if (!parent || parent.parentId !== 0n)
    throw new AppError(404, 'PARENT_STORE_PARENT_REQUIRED', 'Not a parent product.');
  const variants =
    parent.type === 3n
      ? await tx
          .select({ id: Product.id })
          .from(Product)
          .where(and(eq(Product.parent_prod_id, parent.id), liveParentVariantPredicate(tx)))
          .orderBy(asc(Product.id))
          .limit(1001)
          .for('update')
      : [];
  if (variants.length >= 1000)
    throw new AppError(
      503,
      'PARENT_STORE_FAMILY_TOO_WIDE',
      'Reconcile this product family before importing.',
    );
  const familyIds = [
      ...new Set([...variants.map((row) => String(row.id)), command.productId]),
    ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
    resetIds =
      parent.type === 3n
        ? variants.map((row) => String(row.id))
        : parent.type === 1n
          ? [command.productId]
          : [];
  const existing = await tx
    .select({
      id: ProductStore.id,
      productId: ProductStore.product,
      stock: ProductStore.stock,
      available: ProductStore.is_avail,
      archived: ProductStore.is_del,
    })
    .from(ProductStore)
    .where(
      and(
        eq(ProductStore.store, BigInt(command.storeId)),
        inArray(ProductStore.product, familyIds.map(BigInt)),
      ),
    )
    .orderBy(asc(ProductStore.product), asc(ProductStore.id))
    .limit(1001)
    .for('update');
  if (
    existing.length > familyIds.length ||
    new Set(existing.map((row) => String(row.productId))).size !== existing.length
  )
    throw new AppError(
      503,
      'PARENT_STORE_ASSOCIATIONS_AMBIGUOUS',
      'Reconcile duplicate store associations before importing.',
    );
  return { ...command, familyIds, resetIds, existing };
}
