import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { inventoryWorkbookRowSchema, type InventoryWorkbookPage } from './contracts.js';
import { InventoryWorkbookAmbiguityError } from './errors.js';

const count = z.union([z.string().regex(/^\d+$/), z.number().int().safe()]).transform(BigInt);
const projected = inventoryWorkbookRowSchema
  .extend({ variant_count: count, gtin_count: count, category_count: count })
  .strict();
const rank = sql`CASE WHEN hc.cat_id=153 THEN FIELD(153,hc.cat_id) ELSE hc.id END`;
const rankMinimum = sql`(SELECT MIN(CASE WHEN ranking.cat_id=153 THEN FIELD(153,ranking.cat_id) ELSE ranking.id END)
  FROM has_categories ranking WHERE ranking.prod_id=pap.id AND ranking.cat_id NOT IN (162,148))`;
export function inventoryCandidateQuery(storeId: string, after: string, limit: number) {
  identifier.parse(storeId);
  z.string().regex(/^\d+$/).parse(after);
  z.number().int().min(1).max(5000).parse(limit);
  return sql`SELECT CAST(p.id AS CHAR) AS id FROM products p JOIN product_store ps ON ps.product_id=p.id
    WHERE p.prod_type IN (1,4,5) AND ps.is_del=0 AND ps.store_id=CAST(${storeId} AS SIGNED)
      AND ps.product_id>CAST(${after} AS SIGNED) ORDER BY ps.product_id LIMIT ${limit}`;
}
export function inventoryRowsQuery(storeId: string, ids: readonly string[]) {
  identifier.parse(storeId);
  if (!ids.length || ids.length > 5000) throw new Error('Workbook page size is invalid.');
  ids.forEach((id) => identifier.parse(id));
  const values = sql.join(
    ids.map((id) => sql`CAST(${id} AS UNSIGNED)`),
    sql`,`,
  );
  return sql`SELECT CAST(p.id AS CHAR) AS id,s.store_name,CAST(pap.id AS CHAR) AS parent_id,
    CAST(p.id AS CHAR) AS child_id,pap.product,pap.erp_product,c.category,ps.stock AS inventory,
    (SELECT MIN(ho.attr_val) FROM has_options ho WHERE ho.prod_id=p.id) AS variant,
    CAST((SELECT MIN(pg.gtin) FROM products_gs1 pg WHERE pg.product_id=p.id) AS CHAR) AS gtin,
    CAST((SELECT COUNT(DISTINCT CAST(ho.attr_val AS BINARY)) FROM has_options ho WHERE ho.prod_id=p.id) AS CHAR) AS variant_count,
    CAST((SELECT COUNT(DISTINCT pg.gtin) FROM products_gs1 pg WHERE pg.product_id=p.id) AS CHAR) AS gtin_count,
    CAST((SELECT COUNT(DISTINCT CAST(cc.category AS BINARY))+COALESCE(MAX(cc.category IS NULL),0)
      FROM has_categories hc LEFT JOIN categories cc ON cc.id=hc.cat_id
      WHERE hc.prod_id=pap.id AND hc.cat_id NOT IN (162,148) AND ${rank}=${rankMinimum}) AS CHAR) AS category_count
    FROM products p JOIN products pap ON pap.id=CASE WHEN p.parent_prod_id>0 THEN p.parent_prod_id ELSE p.id END
    JOIN product_store ps ON ps.product_id=p.id AND ps.store_id=CAST(${storeId} AS SIGNED) AND ps.is_del=0
    JOIN stores s ON s.id=ps.store_id JOIN users_artists ua ON ua.id=pap.added_by
    LEFT JOIN categories c ON c.id=(SELECT hc.cat_id FROM has_categories hc
      WHERE hc.prod_id=pap.id AND hc.cat_id NOT IN (162,148) ORDER BY ${rank} LIMIT 1)
    WHERE p.prod_type IN (1,4,5) AND p.id IN (${values})
      AND EXISTS(SELECT 1 FROM product_store paps WHERE paps.product_id=pap.id AND paps.is_del=0)
    ORDER BY p.id`;
}
export async function readInventoryWorkbookPage(
  tx: AdministrationTransaction,
  storeId: string,
  after: string,
  limit: number,
  signal: AbortSignal,
): Promise<InventoryWorkbookPage> {
  signal.throwIfAborted();
  const candidates = await tx.execute(inventoryCandidateQuery(storeId, after, limit));
  signal.throwIfAborted();
  const candidateIds = z
    .array(z.object({ id: identifier }).strict())
    .max(limit)
    .parse(candidates[0])
    .map((row) => row.id);
  if (!candidateIds.length) return { candidateIds, rows: [] };
  const raw = await tx.execute(inventoryRowsQuery(storeId, candidateIds));
  signal.throwIfAborted();
  const rows = z.array(projected).max(limit).parse(raw[0]);
  for (const row of rows) {
    const field =
      row.variant_count > 1n
        ? 'variant'
        : row.gtin_count > 1n
          ? 'GTIN'
          : row.category_count > 1n
            ? 'category'
            : null;
    if (field) throw new InventoryWorkbookAmbiguityError(row.id, field);
  }
  return {
    candidateIds,
    rows: rows.map(
      ({ variant_count: _variants, gtin_count: _gtins, category_count: _categories, ...row }) =>
        row,
    ),
  };
}
