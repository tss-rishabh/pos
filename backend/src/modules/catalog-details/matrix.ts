import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { Product, ProductStore, Store } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { countValue } from './contracts.js';
import { sourcePageStart } from './domain.js';
export const inventoryMatrixInput = z
  .object({
    storeIds: z.array(identifier).max(5000).default([]),
    search: z.string().max(150).default(''),
    sort: z.enum(['id', 'product', 'erp_product']).default('id'),
    direction: z.enum(['asc', 'desc']).default('asc'),
    start: z.number().int().min(0).max(1000000).default(0),
    length: z.number().int().min(1).max(500).default(10),
    draw: z.number().int().min(0).max(2147483647).default(0),
  })
  .strict();
const matrixEligible = sql`${Product.product}<>'' and not(${Product.parent_prod_id}=0 and ${Product.prod_type}=3) and ((${Product.is_del}=0 and not exists(select 1 from products removed_parent where removed_parent.id=${Product.parent_prod_id} and removed_parent.is_del=1 and removed_parent.prod_type=3 and removed_parent.parent_prod_id=0)) or exists(select 1 from ${ProductStore} where ${ProductStore.product}=${Product.id} and ${ProductStore.is_del}=0 and ${ProductStore.stock}>0))`;
export function inventoryMatrixService(db: Databases) {
  return {
    async search(user: Principal, value: z.infer<typeof inventoryMatrixInput>) {
      const input = inventoryMatrixInput.parse(value);
      if (user.userType !== 1)
        throw new AppError(
          403,
          'INVENTORY_ADMINISTRATION_DENIED',
          'Stock administration is restricted for this user type.',
        );
      input.storeIds = [...new Set(input.storeIds)];
      input.storeIds.forEach((id) => requireStore(user, id));
      if (user.role !== 1 && !user.storeIds.length)
        return {
          reader: 'primary' as const,
          draw: input.draw,
          recordsTotal: 0,
          recordsFiltered: 0,
          unfilteredCount: 0,
          start: 0,
          stores: [],
          data: [],
        };
      const stores = await db
        .get('primary')
        .select({ id: Store.id, name: Store.store_name })
        .from(Store)
        .where(
          and(
            eq(Store.is_active, true),
            input.storeIds.length
              ? inArray(Store.id, input.storeIds.map(BigInt))
              : user.role !== 1
                ? inArray(Store.id, user.storeIds.map(BigInt))
                : undefined,
          ),
        )
        .orderBy(asc(Store.store_name), asc(Store.id))
        .limit(5001);
      if (stores.length > 5000)
        throw new AppError(422, 'CATALOG_SCOPE_TOO_LARGE', 'Select a smaller catalog store scope.');
      if (input.storeIds.length && input.storeIds.length !== stores.length)
        throw new AppError(
          400,
          'INACTIVE_CATALOG_STORE',
          'Select active stores from the catalog store list.',
        );
      if (!stores.length)
        return {
          reader: 'primary' as const,
          draw: input.draw,
          recordsTotal: 0,
          recordsFiltered: 0,
          unfilteredCount: 0,
          start: 0,
          stores: [],
          data: [],
        };
      // Django icontains escapes SQL wildcards, unlike the raw products datatable.
      const pattern = `%${input.search.replace(/[\\%_]/g, '\\$&')}%`,
        match = input.search
          ? sql`(${Product.product} like ${pattern} or cast(${Product.id} as char) like ${pattern})`
          : sql`true`;
      const [counts] = z
        .array(z.object({ unfiltered: countValue, filtered: countValue }))
        .parse(
          (
            await db
              .get('primary')
              .execute(
                sql`select count(*) as unfiltered,coalesce(sum(case when ${match} then 1 else 0 end),0) as filtered from ${Product} where ${matrixEligible}`,
              )
          )[0],
        );
      const filtered = counts?.filtered || 0,
        start = sourcePageStart(input.start, input.length, filtered),
        parent = alias(Product, 'inventory_parent');
      const rows = await db
        .get('primary')
        .select({
          id: Product.id,
          name: Product.product,
          parentId: Product.parent_prod_id,
          type: Product.prod_type,
          parentFound: parent.id,
          erpName: sql<string>`coalesce(nullif(case when ${Product.parent_prod_id}=0 then ${Product.erp_product} else ${parent.erp_product} end,''),'-')`,
        })
        .from(Product)
        .leftJoin(parent, eq(parent.id, Product.parent_prod_id))
        .where(and(matrixEligible, match))
        .orderBy(
          input.direction === 'asc'
            ? sql`${Product[input.sort]} asc`
            : sql`${Product[input.sort]} desc`,
          asc(Product.id),
        )
        .limit(input.length)
        .offset(start);
      if (rows.some((row) => row.parentId > 0n && row.parentFound === null))
        throw new AppError(
          422,
          'CATALOG_PARENT_RECONCILIATION_REQUIRED',
          'A variant has a missing parent. Reconcile its product family before continuing.',
        );
      if (rows.length * stores.length > 10000)
        throw new AppError(
          422,
          'INVENTORY_MATRIX_TOO_LARGE',
          'Select fewer stores or a smaller page size.',
        );
      const stock = rows.length
        ? await db
            .get('primary')
            .select({
              productId: ProductStore.product,
              storeId: ProductStore.store,
              stock: ProductStore.stock,
              available: ProductStore.is_avail,
              deleted: ProductStore.is_del,
            })
            .from(ProductStore)
            .where(
              and(
                inArray(
                  ProductStore.product,
                  rows.map((row) => row.id),
                ),
                inArray(
                  ProductStore.store,
                  stores.map((store) => store.id),
                ),
              ),
            )
            .orderBy(asc(ProductStore.id))
        : [];
      const grouped = new Map<string, typeof stock>();
      for (const row of stock) {
        const key = String(row.productId),
          current = grouped.get(key) || [];
        current.push(row);
        grouped.set(key, current);
      }
      return {
        reader: 'primary' as const,
        draw: input.draw,
        recordsTotal: filtered,
        recordsFiltered: filtered,
        unfilteredCount: counts?.unfiltered || 0,
        start,
        stores: stores.map((store) => ({
          id: String(store.id),
          name: store.name || String(store.id),
        })),
        data: rows.map((row) => {
          const entries = grouped.get(String(row.id)) || [];
          return {
            id: String(row.id),
            DT_RowId: String(row.id),
            product: row.name,
            erp_product: row.erpName,
            ParentProductId: String(row.parentId),
            productType: String(row.type),
            stores: entries.map((entry) => String(entry.storeId)),
            product_store_stock: entries.length
              ? Object.fromEntries(entries.map((entry) => [String(entry.storeId), entry.stock]))
              : [],
            product_store_stock_is_avail: entries.length
              ? Object.fromEntries(entries.map((entry) => [String(entry.storeId), entry.available]))
              : [],
            product_store_stock_is_del: entries.length
              ? Object.fromEntries(entries.map((entry) => [String(entry.storeId), entry.deleted]))
              : [],
          };
        }),
      };
    },
  };
}
