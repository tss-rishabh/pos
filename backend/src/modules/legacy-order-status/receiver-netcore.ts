import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { HasProduct, Product } from '../../db/legacy-schema.js';
import type { Databases } from '../../db/pools.js';
import { statusReconciliation } from './domain.js';
import { statusNetcoreLines } from './receiver-schema.js';
import type { StatusCommand } from './transport.js';
import type { SourceNetcoreProduct } from '../../../compatibility/upstream/whole-order-status/pinned-source.js';
export async function readStatusNetcore(
  db: Databases,
  row: StatusCommand,
): Promise<SourceNetcoreProduct[]> {
  const parent = alias(Product, 'status_netcore_parent'),
    extra = alias(statusNetcoreLines, 'store_status_hp_extras'),
    lines = await db
      .get('writer')
      .select({
        id: HasProduct.id,
        userId: sql<string>`${row.snapshot.customerId}`,
        prodId: HasProduct.product,
        parentProdId: Product.parent_prod_id,
        qty: HasProduct.qty,
        urlKey: sql<string | null>`COALESCE(${parent.url_key},${Product.url_key})`,
        price: HasProduct.price,
        genderType: extra.genderType,
      })
      .from(HasProduct)
      .leftJoin(Product, eq(Product.id, HasProduct.product))
      .leftJoin(
        parent,
        and(eq(parent.id, Product.parent_prod_id), sql`${Product.parent_prod_id}<>0`),
      )
      .innerJoin(extra, eq(extra.id, HasProduct.id))
      .where(eq(HasProduct.order, BigInt(row.orderId)))
      .orderBy(HasProduct.id)
      .limit(10001);
  if (
    lines.length !== row.snapshot.lines.length ||
    !Number.isSafeInteger(lines.reduce((sum, value) => sum + Number(value.qty), 0)) ||
    lines.some(
      (value, i) =>
        String(value.id) !== row.snapshot.lines[i]?.id ||
        String(value.prodId) !== row.snapshot.lines[i]?.productId ||
        String(value.qty) !== row.snapshot.lines[i]?.quantity ||
        !Number.isSafeInteger(Number(value.qty)) ||
        !Number.isFinite(value.price),
    )
  )
    throw statusReconciliation();
  return lines.map((value) => ({
    userId: BigInt(row.snapshot.customerId),
    prodId: value.prodId,
    parentProdId: value.parentProdId,
    qty: Number(value.qty),
    urlKey: value.urlKey,
    price: value.price,
    genderType: value.genderType,
  }));
}
