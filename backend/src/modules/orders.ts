import { and, desc, eq, gte, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Databases } from '../db/pools.js';
import { Order, OrderStatus, OrderStore, PaymentStatus } from '../db/legacy-schema.js';
import { AppError } from '../domain/errors.js';
import type { Principal } from '../domain/access.js';
import {
  orderRange,
  positiveId,
  type OrderReadSelection,
  type OrderListPage,
  type OrderDetail,
  type OrderReadRange,
} from './order-history/contracts.js';
import { orderCursors } from './order-history/cursor.js';
import { orderReadAuthority } from './order-history/authority.js';
import { storeOrderDetailReader } from './order-history/store-detail.js';
export type { OrderReadSelection } from './order-history/contracts.js';
export interface OrdersService {
  list(
    user: Principal,
    storeId: string,
    before?: string,
    limit?: number,
    selection?: OrderReadSelection,
  ): Promise<OrderListPage>;
  /** `crossAccess` is the legacy `?cr=1` order-ID link (`order/views.py:358-366`). */
  detail(
    user: Principal,
    storeId: string,
    orderId: string,
    selection?: { crossAccess?: boolean },
  ): Promise<OrderDetail>;
}

/**
 * Store order list and detail. Both read MySQL as legacy does (`OrdersView`,
 * `ShowOrderDetailsView` use the default database for every order date); there is no
 * warehouse path for orders.
 */
export function ordersService(
  db: Databases,
  config?: Config,
  clock: () => number = Date.now,
): OrdersService {
  const authorize = orderReadAuthority(db),
    cursors = orderCursors(config?.SESSION_SECRET, clock),
    detail = config ? storeOrderDetailReader(config, db, clock) : undefined;
  const range = (selection: OrderReadSelection = {}, now = clock()): OrderReadRange => ({
    ...orderRange(selection, config?.BUSINESS_TIMEZONE ?? 'Asia/Kolkata', now),
    reader: 'primary',
  });
  async function recheck(user: Principal, storeId: string, version: string) {
    if ((await authorize(user, storeId)) !== version)
      throw new AppError(
        403,
        'ORDER_READ_SCOPE_CHANGED',
        'Your order-viewing permissions changed. Refresh this store.',
      );
  }
  return {
    async list(user, storeId, before, rawLimit = 30, selection = {}) {
      positiveId.parse(storeId);
      const limit = z.number().int().min(1).max(100).parse(rawLimit),
        r = range(selection),
        version = await authorize(user, storeId),
        scope = { actor: user.id, store: storeId, range: r },
        anchor = cursors.decode(before, scope);
      const rows = await db
        .get('primary')
        .select({
          rowId: OrderStore.id,
          id: Order.id,
          reference: Order.order_ref_no,
          first: Order.first_name,
          last: Order.last_name,
          amount: Order.pay_amt,
          status: OrderStatus.display_name,
          paymentStatus: PaymentStatus.payment_status,
          createdAt: Order.created_at,
        })
        .from(OrderStore)
        .innerJoin(Order, eq(OrderStore.order, Order.id))
        .leftJoin(OrderStatus, eq(OrderStatus.id, Order.order_statuses))
        .leftJoin(PaymentStatus, eq(PaymentStatus.id, Order.payment_statuses))
        .where(
          and(
            eq(OrderStore.store, BigInt(storeId)),
            gte(Order.created_at, r.start),
            lt(Order.created_at, r.end),
            anchor
              ? or(
                  lt(Order.id, BigInt(anchor.orderId)),
                  and(
                    eq(Order.id, BigInt(anchor.orderId)),
                    lt(OrderStore.id, BigInt(anchor.rowId)),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(Order.id), desc(OrderStore.id))
        .limit(limit + 1);
      await recheck(user, storeId, version);
      const selected = rows.slice(0, limit),
        last = selected.at(-1);
      return {
        reader: 'primary',
        range: r,
        fetchedAt: new Date(clock()).toISOString(),
        data: selected.map((row) => ({
          id: String(row.id),
          rowId: String(row.rowId),
          reference: row.reference,
          storeId,
          customer: `${row.first} ${row.last}`.trim(),
          amount: String(row.amount),
          status: row.status || '',
          paymentStatus: row.paymentStatus || '',
          createdAt: row.createdAt,
        })),
        nextCursor:
          rows.length > limit && last
            ? cursors.encode(scope, { orderId: String(last.id), rowId: String(last.rowId) }, null)
            : null,
      };
    },
    async detail(user, storeId, orderId, selection = {}) {
      positiveId.parse(storeId);
      positiveId.parse(orderId);
      if (!detail)
        throw new AppError(503, 'ORDER_DETAIL_UNAVAILABLE', 'Order details are unavailable.');
      return detail(user, storeId, orderId, selection.crossAccess === true);
    },
  };
}
