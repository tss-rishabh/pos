import { and, asc, desc, eq, gt, ne, not, notExists, or, sql } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { Product, ProductBarcode, ProductStore, Store } from '../../db/legacy-schema.js';
import { catalogPriceList } from './schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { scalarId } from '../operational-reports/report-inputs.js';
import { assertCatalogScope } from './service.js';
/**
 * `AjaxCatalogueView` (core/views.py:1647-1719). Its price dicts are filled row by row, so with
 * several pricelist-2 rows for a product the last row in primary-key order
 * (product_id, pricelist_id, location_id) wins: `order by location_id desc limit 1`. The barcode
 * likewise takes the highest products_gs1 id. A NULL/0 last price prints 0 (`or 0`).
 */
const subquery = new QueryBuilder(),
  parent = alias(Product, 'parent'),
  removedParent = alias(Product, 'dp');
/** The offline snapshot projection and filters for one store, as a builder statement. */
export function snapshotSelect(db: ReturnType<Databases['get']>, storeId: string) {
  const own = eq(Product.parent_prod_id, 0n);
  return db
    .select({
      id: sql<string>`cast(${Product.id} as char)`,
      product: Product.product,
      barcode: sql<string>`coalesce(nullif(${subquery
        .select({ gtin: sql`cast(${ProductBarcode.gtin} as char)` })
        .from(ProductBarcode)
        .where(eq(ProductBarcode.product, Product.id))
        .orderBy(desc(ProductBarcode.id))
        .limit(1)},'0'),'Barcode Missing')`,
      price: sql<string | null>`case when ${own} then ${Product.price} else ${parent.price} end`,
      spl_price: sql<
        string | null
      >`case when ${own} then ${Product.spl_price} else ${parent.spl_price} end`,
      exclusive_price: sql<number>`coalesce(${subquery
        .select({ price: catalogPriceList.price })
        .from(catalogPriceList)
        .where(
          and(
            eq(
              catalogPriceList.product_id,
              sql`case when ${own} then ${Product.id} else ${Product.parent_prod_id} end`,
            ),
            eq(catalogPriceList.pricelist_id, 2),
          ),
        )
        .orderBy(desc(catalogPriceList.location_id))
        .limit(1)},0)`,
      stock: ProductStore.stock,
    })
    .from(Product)
    .innerJoin(
      ProductStore,
      and(eq(ProductStore.product, Product.id), eq(ProductStore.store, BigInt(storeId))),
    )
    .leftJoin(parent, eq(parent.id, Product.parent_prod_id))
    .where(
      and(
        eq(ProductStore.is_del, false),
        eq(ProductStore.is_avail, true),
        ne(Product.product, ''),
        not(and(own, eq(Product.prod_type, 3n))!),
        or(
          and(
            eq(Product.is_del, 0),
            notExists(
              subquery
                .select({ id: removedParent.id })
                .from(removedParent)
                .where(
                  and(
                    eq(removedParent.id, Product.parent_prod_id),
                    eq(removedParent.is_del, 1),
                    eq(removedParent.prod_type, 3n),
                    eq(removedParent.parent_prod_id, 0n),
                  ),
                ),
            ),
          ),
          gt(ProductStore.stock, 0),
        ),
      ),
    )
    .orderBy(asc(Product.id))
    .limit(70001);
}
const row = z.object({
  id: scalarId,
  product: z.string(),
  barcode: z.string(),
  price: z.string().nullable(),
  spl_price: z.string().nullable(),
  exclusive_price: z.coerce.number().finite(),
  stock: z.number().int(),
});
export function catalogSnapshotService(db: Databases) {
  return {
    async read(user: Principal, storeId: string) {
      assertCatalogScope(user, [storeId]);
      const [store] = await db
        .get('primary')
        .select({ id: Store.id, name: Store.store_name })
        .from(Store)
        .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
        .limit(1);
      if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Active store was not found.');
      const rows = z.array(row).parse(await snapshotSelect(db.get('primary'), storeId));
      if (rows.length > 70000)
        throw new AppError(
          422,
          'CATALOG_SNAPSHOT_TOO_LARGE',
          'This catalog exceeds the supported offline snapshot size. Reconcile its store scope before continuing.',
        );
      return {
        reader: 'primary' as const,
        store: { id: String(store.id), name: store.name || String(store.id) },
        syncedAt: new Date().toISOString(),
        data: rows.map(
          (value) =>
            [
              value.id,
              value.product,
              value.barcode,
              value.price,
              value.spl_price,
              value.exclusive_price,
              value.stock,
            ] as const,
        ),
      };
    },
  };
}
