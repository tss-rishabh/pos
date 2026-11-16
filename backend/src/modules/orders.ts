import { and, desc, eq, lt } from 'drizzle-orm';
import type { Databases } from '../db/pools.js';
import {
  HasProduct,
  Order,
  OrderStatus,
  OrderStore,
  PaymentStatus,
  Product,
} from '../db/legacy-schema.js';
import { AppError } from '../domain/errors.js';
import { requireStore, type Principal } from '../domain/access.js';
import type { OrderDto, Page } from '../domain/contracts.js';

export function ordersService(db: Databases) {
  return {
    async list(
      user: Principal,
      storeId: string,
      before?: string,
      limit = 30,
    ): Promise<Page<OrderDto>> {
      requireStore(user, storeId);
      const rows = await db
        .get('primary')
        .select({
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
            before ? lt(Order.id, BigInt(before)) : undefined,
          ),
        )
        .orderBy(desc(Order.id))
        .limit(limit + 1);
      const selected = rows.slice(0, limit);
      return {
        data: selected.map((r) => ({
          id: String(r.id),
          reference: r.reference,
          storeId,
          customer: `${r.first} ${r.last}`.trim(),
          amount: String(r.amount),
          status: r.status || '',
          paymentStatus: r.paymentStatus || '',
          createdAt: r.createdAt,
        })),
        nextCursor: rows.length > limit ? String(selected.at(-1)!.id) : null,
      };
    },
    async detail(user: Principal, storeId: string, orderId: string) {
      requireStore(user, storeId);
      const rows = await db
        .get('primary')
        .select({
          id: Order.id,
          reference: Order.order_ref_no,
          amount: Order.pay_amt,
          createdAt: Order.created_at,
          status: OrderStatus.display_name,
          paymentStatusId: Order.payment_statuses,
        })
        .from(OrderStore)
        .innerJoin(Order, eq(OrderStore.order, Order.id))
        .leftJoin(OrderStatus, eq(OrderStatus.id, Order.order_statuses))
        .where(and(eq(OrderStore.store, BigInt(storeId)), eq(Order.id, BigInt(orderId))))
        .limit(1);
      const order = rows[0];
      if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found in this store.');
      const lines = await db
        .get('primary')
        .select({
          id: HasProduct.id,
          productId: HasProduct.product,
          name: Product.product,
          quantity: HasProduct.qty,
          amount: HasProduct.price,
          gst: HasProduct.gst,
          status: HasProduct.status,
        })
        .from(HasProduct)
        .leftJoin(Product, eq(Product.id, HasProduct.product))
        .where(eq(HasProduct.order, BigInt(orderId)));
      const { paymentStatusId, ...publicOrder } = order;
      return { ...publicOrder, isPaid: paymentStatusId === 4n, lines };
    },
  };
}
export type OrdersService = ReturnType<typeof ordersService>;
