// Frozen pre-W11 copy (integration head 43613a75) of the raw-SQL implementation. Characterisation
// oracle only: tests/catalog-details/orm-characterisation.mysql.test.ts compares it with src.
import { sql, type SQL } from 'drizzle-orm';
import { Product, ProductStore, Store } from '../../../src/db/legacy-schema.js';
import { catalogProductTypes } from '../../../src/modules/catalog-details/schema.js';
import type { ProductSearchInput } from '../../../src/modules/catalog-details/contracts.js';

export const productTypeJoin = sql`left join ${catalogProductTypes} on ${catalogProductTypes.id}=${Product.prod_type}`;
/** Correlated to the current product/store row exactly as in the source datatable. */
export const sourceStoreVisibility = sql`(${Product.is_del}=0 or (${ProductStore.is_del}=0 and (${ProductStore.stock}>0 or exists (select 1 from product_store vps join products v on v.id=vps.product_id where v.parent_prod_id=${Product.id} and vps.store_id=${ProductStore.store} and vps.is_del=0 and vps.stock>0))))`;
export function selectedStoreVisibility(ids: readonly string[]) {
  return sql`${Store.id} in (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`,`,
  )}) and ${sourceStoreVisibility}`;
}
export function catalogEligible(ids: readonly string[]) {
  return sql`${Product.product}<>'' and ${Product.parent_prod_id}=0 and ${Product.prod_type}<>5 and exists(select 1 from ${ProductStore} join ${Store} on ${Store.id}=${ProductStore.store} where ${ProductStore.product}=${Product.id} and ${selectedStoreVisibility(ids)})`;
}
export function sourceProductSearch(search: string): SQL {
  if (!search) return sql`true`;
  // Source treats LIKE wildcards as wildcards and normalizes double quotes to single quotes.
  const pattern = `%${search.replaceAll('"', "'")}%`;
  return sql`(cast(${Product.id} as char) like ${pattern} or ${Product.product} like ${pattern} or ${Product.url_key} like ${pattern} or ${catalogProductTypes.type} like ${pattern})`;
}
export function catalogCountQuery(input: ProductSearchInput) {
  return sql`select count(*) as unfiltered_count, coalesce(sum(case when ${sourceProductSearch(input.search)} then 1 else 0 end),0) as filtered_count from ${Product} ${productTypeJoin} where ${catalogEligible(input.storeIds)}`;
}
export function catalogPriceConflictQuery(input: ProductSearchInput) {
  return sql`select 1 as conflict from ${Product} ${productTypeJoin} where ${catalogEligible(input.storeIds)} and ${sourceProductSearch(input.search)} and (select count(distinct pl.price)+if(count(*)>count(pl.price),1,0) from pricelist pl where pl.product_id=${Product.id} and pl.pricelist_id=2)>1 limit 1`;
}
export function catalogPageQuery(input: ProductSearchInput, start: number) {
  const categories = sql`(select group_concat(distinct cat.category) from has_categories hc left join categories cat on cat.id=hc.cat_id where hc.prod_id=${Product.id})`;
  const storeNames = sql`(select group_concat(distinct ${Store.store_name}) from ${ProductStore} join ${Store} on ${Store.id}=${ProductStore.store} where ${ProductStore.product}=${Product.id} and ${selectedStoreVisibility(input.storeIds)})`;
  const exclusivePrice = sql`(select min(pl.price) from pricelist pl where pl.product_id=${Product.id} and pl.pricelist_id=2)`;
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
  const direction = input.direction === 'asc' ? sql`asc` : sql`desc`;
  // LIMIT makes this derived selection non-mergeable: page IDs before enriching the chosen rows.
  // Aggregate sorts calculate only their own key before pagination, not every other projection.
  const selected = sql`select ${Product.id} as product_id from ${Product} ${productTypeJoin} where ${catalogEligible(input.storeIds)} and ${sourceProductSearch(input.search)} order by ${sort} ${direction},${Product.id} asc limit ${input.length} offset ${start}`;
  return sql`select cast(${Product.id} as char) as id, ${Product.product} as product, ${Product.erp_product} as erp_product, ${Product.price} as price, ${Product.spl_price} as spl_price,
    ${exclusivePrice} as exclusive_price,
    (select count(distinct pl.price)+if(count(*)>count(pl.price),1,0) from pricelist pl where pl.product_id=${Product.id} and pl.pricelist_id=2) as exclusive_price_choices,
    ${catalogProductTypes.type} as prod_type,
    ${categories} as categories,${storeNames} as store_names
    from (${selected}) selected join ${Product} on ${Product.id}=selected.product_id ${productTypeJoin}
    order by ${input.sort === 'id' ? Product.id : sql.identifier(input.sort)} ${direction}, ${Product.id} asc`;
}
