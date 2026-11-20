import { and, asc, desc, eq, exists, gt, inArray, lt, lte, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { HasProduct, Order, OrderStore, Product } from '../../db/legacy-schema.js';
import { NpsFeedback } from '../operational-reports/feedback-schema.js';

/** Returned rows show the first 20 item names; the lines route pages the rest. */
export const initialReturnedItems = 20;

export interface HistoryGateway {
  read(customerId: string, before: string, limit: number): Promise<unknown>;
  lines(customerId: string, orderId: string, before: string, limit: number): Promise<unknown>;
}

const isoDate = z.iso.date();
/** `DATE()` of a zero/invalid legacy DATETIME is not a calendar date; show no date. */
const calendarDate = (value: string | null) => (isoDate.safeParse(value).success ? value : null);
const decimal = (value: unknown) => String(value ?? 0);
const flag = (value: unknown) => Number(value) === 1;

/**
 * Customer history from MySQL for all dates, as legacy `users/views.py:AjaxUserbehaviourView`
 * (804–1006) reads it (user decision, 20 November 2026). Interactive reads route to the primary
 * reader. Every statement runs in one read-only REPEATABLE READ transaction, so the summary,
 * recent orders and returned page describe the same moment. Values are bound; no request text
 * reaches SQL.
 */
export function customerHistoryGateway(db: Databases): HistoryGateway {
  // routeRead({ kind: 'interactive' }) is always the primary reader.
  const reader = () => db.get('primary');
  // REPEATABLE READ fixes the snapshot at the first read. Drizzle renders `withConsistentSnapshot`
  // together with `read only` as invalid SQL, so it is not requested.
  const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;
  return {
    read: (customerId, before, limit) =>
      reader().transaction(async (tx) => {
        const customer = BigInt(customerId),
          own = eq(Order.user, customer),
          storeOrder = exists(
            tx.select({ id: OrderStore.id }).from(OrderStore).where(eq(OrderStore.order, Order.id)),
          ),
          effective = alias(Product, 'effective_product'),
          parent = alias(Product, 'parent_product');
        // get_lifetime_exclusive_savings (users/views.py:877-893).
        const [savings] = await tx
          .select({
            amount: sql<
              number | string
            >`IFNULL(ROUND(SUM((${parent.price}*${HasProduct.qty})-${HasProduct.price}),0),0)`,
          })
          .from(Order)
          .leftJoin(HasProduct, eq(HasProduct.order, Order.id))
          .leftJoin(
            effective,
            eq(
              effective.id,
              sql`CASE WHEN ${HasProduct.sub_prod_id}>0 THEN ${HasProduct.sub_prod_id} ELSE ${HasProduct.product} END`,
            ),
          )
          .leftJoin(
            parent,
            eq(
              parent.id,
              sql`CASE WHEN ${effective.parent_prod_id}>0 THEN ${effective.parent_prod_id} ELSE ${effective.id} END`,
            ),
          )
          .where(and(own, notInArray(Order.order_statuses, [0n, 4n, 7n, 10n, 17n, 22n])));
        // get_total_orders (users/views.py:924-943): order_stores multiplicity is kept.
        const [totals] = await tx
          .select({
            store: sql<string>`COUNT(${OrderStore.id})`,
            total: sql<string>`COUNT(${Order.id})`,
          })
          .from(Order)
          .leftJoin(OrderStore, eq(OrderStore.order, Order.id))
          .where(and(own, notInArray(Order.order_statuses, [0n, 17n])));
        // get_last_orders (users/views.py:905-922) uses the reader's NOW(), as legacy does.
        const [last30] = await tx
          .select({ count: sql<string>`COUNT(${Order.id})` })
          .from(Order)
          .where(
            and(
              own,
              notInArray(Order.order_statuses, [0n, 17n]),
              gt(Order.created_at, sql`NOW() - INTERVAL 30 DAY`),
            ),
          );
        // get_cancelled_orders / get_returned_orders counts (users/views.py:945-965).
        const [statuses] = await tx
          .select({
            cancelled: sql<string>`COUNT(CASE WHEN ${Order.order_statuses}=4 THEN 1 END)`,
            returned: sql<string>`COUNT(CASE WHEN ${Order.order_statuses}=6 THEN 1 END)`,
          })
          .from(Order)
          .where(own);
        // get_nps_score (users/views.py:967-984): MySQL string-to-number AVG of the raw answer.
        const [nps] = await tx
          .select({ score: sql<number | string | null>`AVG(${NpsFeedback.feedback})` })
          .from(NpsFeedback)
          .leftJoin(Order, eq(Order.id, NpsFeedback.orderId))
          .where(own);
        // get_last_5_orders (users/views.py:986-1006): ordered by DATE(created_at) descending;
        // ID descending is the explicit tie order the source leaves undefined.
        const recent = await tx
          .select({
            id: Order.id,
            orderAmount: Order.order_amt,
            createdDate: sql<string | null>`DATE(${Order.created_at})`,
            status: Order.order_statuses,
            isStoreOrder: sql<number | string>`${storeOrder}`,
          })
          .from(Order)
          .where(own)
          .orderBy(desc(sql`DATE(${Order.created_at})`), desc(Order.id))
          .limit(5);
        // get_returned_orders (users/views.py:950-965), one ID-descending page at a time.
        const returned = await tx
          .select({
            id: Order.id,
            orderAmount: Order.order_amt,
            isStoreOrder: sql<number | string>`${storeOrder}`,
          })
          .from(Order)
          .where(
            and(
              own,
              eq(Order.order_statuses, 6n),
              before ? lt(Order.id, BigInt(before)) : undefined,
            ),
          )
          .orderBy(desc(Order.id))
          .limit(limit + 1);
        const items = new Map<string, { names: string[]; count: string }>();
        if (returned.length) {
          const ranked = tx
            .select({
              orderId: HasProduct.order,
              name: Product.product,
              position:
                sql<number>`ROW_NUMBER() OVER(PARTITION BY ${HasProduct.order} ORDER BY ${HasProduct.id} DESC)`.as(
                  'position',
                ),
              total: sql<string>`COUNT(*) OVER(PARTITION BY ${HasProduct.order})`.as('total'),
            })
            .from(HasProduct)
            .innerJoin(Product, eq(Product.id, HasProduct.product))
            .where(
              inArray(
                HasProduct.order,
                returned.map((row) => row.id),
              ),
            )
            .as('ranked_items');
          const rows = await tx
            .select({
              orderId: ranked.orderId,
              name: ranked.name,
              total: ranked.total,
            })
            .from(ranked)
            .where(lte(ranked.position, initialReturnedItems))
            .orderBy(asc(ranked.orderId), asc(ranked.position));
          for (const row of rows) {
            const key = String(row.orderId),
              entry = items.get(key) || { names: [], count: decimal(row.total) };
            entry.names.push(row.name);
            items.set(key, entry);
          }
        }
        const total = BigInt(decimal(totals?.total)),
          store = BigInt(decimal(totals?.store));
        return {
          summary: {
            exclusiveSavings: Number(savings?.amount ?? 0),
            totalOrders: String(total),
            totalStoreOrders: String(store),
            totalOnlineOrders: String(total - store),
            last30DaysOrders: decimal(last30?.count),
            cancelledOrders: decimal(statuses?.cancelled),
            returnedOrders: decimal(statuses?.returned),
            npsScore: nps?.score === null || nps?.score === undefined ? null : Number(nps.score),
          },
          recentOrders: recent.map((row) => ({
            id: String(row.id),
            orderAmount: row.orderAmount,
            createdDate: calendarDate(row.createdDate),
            status: Number(row.status),
            isStoreOrder: flag(row.isStoreOrder),
          })),
          returnedRows: returned.map((row) => {
            const entry = items.get(String(row.id)),
              count = entry?.count || '0';
            return {
              id: String(row.id),
              orderAmount: row.orderAmount,
              itemNames: entry?.names || [],
              itemCount: count,
              hasMoreItems: BigInt(count) > BigInt(initialReturnedItems),
              isStoreOrder: flag(row.isStoreOrder),
            };
          }),
        };
      }, snapshot),
    lines: (customerId, orderId, before, limit) =>
      reader().transaction(async (tx) => {
        const order = BigInt(orderId);
        const [owned] = await tx
          .select({ id: Order.id })
          .from(Order)
          .where(and(eq(Order.id, order), eq(Order.user, BigInt(customerId))))
          .limit(1);
        if (!owned) return { orderFound: false, items: [] };
        // Every has_products row of the order, duplicate SKUs included (HP.prod_id → products).
        const rows = await tx
          .select({ id: HasProduct.id, productId: HasProduct.product, name: Product.product })
          .from(HasProduct)
          .innerJoin(Product, eq(Product.id, HasProduct.product))
          .where(
            and(
              eq(HasProduct.order, order),
              before ? lt(HasProduct.id, BigInt(before)) : undefined,
            ),
          )
          .orderBy(desc(HasProduct.id))
          .limit(limit + 1);
        return {
          orderFound: true,
          items: rows.map((row) => ({
            id: String(row.id),
            productId: String(row.productId),
            name: row.name,
          })),
        };
      }, snapshot),
  };
}
