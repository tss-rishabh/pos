import { and, count, eq, exists, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/mysql-core';
import {
  Store,
  PosUser,
  ProductStore,
  Product,
  OrderStore,
  Order,
} from '../../db/legacy-schema.js';

const builder = new QueryBuilder();
/**
 * One statement, one row: an aggregate without GROUP BY over active stores, with the operator and
 * parent-product counts as uncorrelated scalar subqueries. `COUNT(*)` keeps its raw BIGINT driver
 * value (a decimal string under `bigNumberStrings`), exactly as the former raw statement returned.
 */
export const currentDashboardFields = {
  active_stores: count().mapWith(String).as('active_stores'),
  active_operators: sql`${builder
    .select({ count: count() })
    .from(PosUser)
    .where(eq(PosUser.is_active, true))}`
    .mapWith(String)
    .as('active_operators'),
  parent_products: sql`${builder
    .select({ count: count() })
    .from(Product)
    .where(
      and(
        eq(Product.parent_prod_id, 0n),
        exists(
          builder
            .select({ one: sql`1` })
            .from(ProductStore)
            .where(eq(ProductStore.product, Product.id)),
        ),
      ),
    )}`
    .mapWith(String)
    .as('parent_products'),
};
export const currentDashboardWhere = eq(Store.is_active, true);
export const currentDashboardQuery = () =>
  builder.select(currentDashboardFields).from(Store).where(currentDashboardWhere).getSQL();

export const dailyDashboardFields = { order_count: count().mapWith(String).as('order_count') };
export function dailyDashboardWhere(stores: readonly string[], start: string, end: string) {
  return and(
    inArray(OrderStore.store, stores.map(BigInt)),
    ne(Order.order_statuses, 0n),
    gte(Order.created_at, start),
    lt(Order.created_at, end),
  );
}
export function dailyDashboardQuery(stores: readonly string[], start: string, end: string) {
  return builder
    .select(dailyDashboardFields)
    .from(OrderStore)
    .innerJoin(Order, eq(Order.id, OrderStore.order))
    .where(dailyDashboardWhere(stores, start, end))
    .getSQL();
}
