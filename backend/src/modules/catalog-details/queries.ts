import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  like,
  min,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/mysql-core';
import { HasCategories, Product, ProductStore, Store } from '../../db/legacy-schema.js';
import { catalogCategories, catalogPriceList, catalogProductTypes } from './schema.js';
import type { ProductSearchInput } from './contracts.js';

/** Standalone builder for correlated subqueries; statements run on the caller's reader. */
const subquery = new QueryBuilder();
const variantStore = alias(ProductStore, 'vps'),
  variant = alias(Product, 'v');
/** Correlated to the current product/store row exactly as in the source datatable. */
export const sourceStoreVisibility = or(
  eq(Product.is_del, 0),
  and(
    eq(ProductStore.is_del, false),
    or(
      gt(ProductStore.stock, 0),
      exists(
        subquery
          .select({ id: variantStore.id })
          .from(variantStore)
          .innerJoin(variant, eq(variant.id, variantStore.product))
          .where(
            and(
              eq(variant.parent_prod_id, Product.id),
              eq(variantStore.store, ProductStore.store),
              eq(variantStore.is_del, false),
              gt(variantStore.stock, 0),
            ),
          ),
      ),
    ),
  ),
);
export function selectedStoreVisibility(ids: readonly string[]) {
  return and(inArray(Store.id, ids.map(BigInt)), sourceStoreVisibility);
}
export function catalogEligible(ids: readonly string[]) {
  return and(
    ne(Product.product, ''),
    eq(Product.parent_prod_id, 0n),
    ne(Product.prod_type, 5n),
    exists(
      subquery
        .select({ id: ProductStore.id })
        .from(ProductStore)
        .innerJoin(Store, eq(Store.id, ProductStore.store))
        .where(and(eq(ProductStore.product, Product.id), selectedStoreVisibility(ids))),
    ),
  );
}
export function sourceProductSearch(search: string): SQL | undefined {
  if (!search) return undefined;
  // Source treats LIKE wildcards as wildcards and normalizes double quotes to single quotes.
  const pattern = `%${search.replaceAll('"', "'")}%`;
  return or(
    like(sql`cast(${Product.id} as char)`, pattern),
    like(Product.product, pattern),
    like(Product.url_key, pattern),
    like(catalogProductTypes.type, pattern),
  );
}
/** Distinct membership prices, counting a NULL price as one more choice (source price dict). */
export function exclusivePriceChoices() {
  return sql<string>`count(distinct ${catalogPriceList.price})+if(count(*)>count(${catalogPriceList.price}),1,0)`;
}
function correlatedPriceChoices() {
  return sql<string>`${subquery
    .select({ choices: exclusivePriceChoices() })
    .from(catalogPriceList)
    .where(
      and(eq(catalogPriceList.product_id, Product.id), eq(catalogPriceList.pricelist_id, 2)),
    )}`;
}
export function catalogCountFields(input: ProductSearchInput) {
  const search = sourceProductSearch(input.search);
  return {
    unfiltered_count: sql<string>`count(*)`,
    filtered_count: search
      ? sql<string>`coalesce(sum(case when ${search} then 1 else 0 end),0)`
      : sql<string>`count(*)`,
  };
}
export function catalogConflictCondition(input: ProductSearchInput) {
  return and(
    catalogEligible(input.storeIds),
    sourceProductSearch(input.search),
    gt(correlatedPriceChoices(), 1),
  );
}
export function catalogPageParts(input: ProductSearchInput, start: number) {
  const categories = sql<string | null>`${subquery
    .select({ categories: sql`group_concat(distinct ${catalogCategories.category})` })
    .from(HasCategories)
    .leftJoin(catalogCategories, eq(catalogCategories.id, HasCategories.cat_id))
    .where(eq(HasCategories.prod_id, Product.id))}`;
  const storeNames = sql<string | null>`${subquery
    .select({ storeNames: sql`group_concat(distinct ${Store.store_name})` })
    .from(ProductStore)
    .innerJoin(Store, eq(Store.id, ProductStore.store))
    .where(and(eq(ProductStore.product, Product.id), selectedStoreVisibility(input.storeIds)))}`;
  const exclusivePrice = sql<number | null>`${subquery
    .select({ price: min(catalogPriceList.price) })
    .from(catalogPriceList)
    .where(
      and(eq(catalogPriceList.product_id, Product.id), eq(catalogPriceList.pricelist_id, 2)),
    )}`;
  const sort = {
    id: Product.id,
    product: Product.product,
    erp_product: Product.erp_product,
    prod_type: catalogProductTypes.type,
    price: Product.price,
    spl_price: Product.spl_price,
    categories,
    store_names: storeNames,
    exclusive_price: exclusivePrice,
  }[input.sort];
  const direction = input.direction === 'asc' ? asc : desc;
  // LIMIT makes this derived selection non-mergeable: page IDs before enriching the chosen rows.
  // Aggregate sorts calculate only their own key before pagination, not every other projection.
  const selected = subquery
    .select({ product_id: Product.id })
    .from(Product)
    .leftJoin(catalogProductTypes, eq(catalogProductTypes.id, Product.prod_type))
    .where(and(catalogEligible(input.storeIds), sourceProductSearch(input.search)))
    .orderBy(direction(sort), asc(Product.id))
    .limit(input.length)
    .offset(start)
    .as('selected');
  return {
    selected,
    fields: {
      id: sql<string>`cast(${Product.id} as char)`,
      product: Product.product,
      erp_product: Product.erp_product,
      price: Product.price,
      spl_price: Product.spl_price,
      exclusive_price: exclusivePrice,
      exclusive_price_choices: correlatedPriceChoices(),
      prod_type: catalogProductTypes.type,
      categories,
      store_names: storeNames,
    },
    // The source orders by the projected alias, which is the same expression as the page sort.
    order: [direction(sort), asc(Product.id)],
  };
}
