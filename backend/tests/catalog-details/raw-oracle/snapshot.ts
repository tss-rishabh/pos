// Frozen pre-W11 copy (integration head 43613a75) of the raw-SQL implementation. Characterisation
// oracle only: tests/catalog-details/orm-characterisation.mysql.test.ts compares it with src.
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../src/db/pools.js';
import { Store } from '../../../src/db/legacy-schema.js';
import type { Principal } from '../../../src/domain/access.js';
import { AppError } from '../../../src/domain/errors.js';
import { scalarId } from '../../../src/modules/operational-reports/report-inputs.js';
import { assertCatalogScope } from './service.js';
/**
 * `AjaxCatalogueView` (core/views.py:1647-1719). Its price dicts are filled row by row, so with
 * several pricelist-2 rows for a product the last row in primary-key order
 * (product_id, pricelist_id, location_id) wins: `order by location_id desc limit 1`. The barcode
 * likewise takes the highest products_gs1 id. A NULL/0 last price prints 0 (`or 0`).
 */
export const snapshotQuery = (storeId: string) => sql`select cast(p.id as char) as id,p.product,
  coalesce(nullif((select cast(b.gtin as char) from products_gs1 b where b.product_id=p.id order by b.id desc limit 1),'0'),'Barcode Missing') as barcode,
  case when p.parent_prod_id=0 then p.price else parent.price end as price,
  case when p.parent_prod_id=0 then p.spl_price else parent.spl_price end as spl_price,
  coalesce((select pl.price from pricelist pl where pl.product_id=case when p.parent_prod_id=0 then p.id else p.parent_prod_id end and pl.pricelist_id=2 order by pl.location_id desc limit 1),0) as exclusive_price,
  ps.stock from products p join product_store ps on ps.product_id=p.id and ps.store_id=${storeId} left join products parent on parent.id=p.parent_prod_id
  where ps.is_del=0 and ps.is_avail=1 and p.product<>'' and not(p.parent_prod_id=0 and p.prod_type=3)
    and ((p.is_del=0 and not exists(select 1 from products dp where dp.id=p.parent_prod_id and dp.is_del=1 and dp.prod_type=3 and dp.parent_prod_id=0)) or ps.stock>0)
  order by p.id asc limit 70001`;
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
      const rows = z.array(row).parse((await db.get('primary').execute(snapshotQuery(storeId)))[0]);
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
