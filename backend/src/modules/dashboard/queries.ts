import { sql } from 'drizzle-orm';
import {
  Store,
  PosUser,
  ProductStore,
  Product,
  OrderStore,
  Order,
} from '../../db/legacy-schema.js';
export const currentDashboardQuery = () => sql`SELECT
 (SELECT COUNT(*) FROM ${Store} WHERE ${Store.is_active}=1) AS active_stores,
 (SELECT COUNT(*) FROM ${PosUser} WHERE ${PosUser.is_active}=1) AS active_operators,
 (SELECT COUNT(*) FROM ${Product} WHERE ${Product.parent_prod_id}=0 AND EXISTS(SELECT 1 FROM ${ProductStore} WHERE ${ProductStore.product}=${Product.id})) AS parent_products`;
export function dailyDashboardQuery(stores: readonly string[], start: string, end: string) {
  return sql`SELECT COUNT(*) AS order_count FROM ${OrderStore} INNER JOIN ${Order} ON ${Order.id}=${OrderStore.order}
 WHERE ${
   stores.length
     ? sql`${OrderStore.store} IN (${sql.join(
         stores.map((id) => sql`${BigInt(id)}`),
         sql`,`,
       )})`
     : sql`FALSE`
 } AND ${Order.order_statuses}<>0
 AND ${Order.created_at}>=${start} AND ${Order.created_at}<${end}`;
}
