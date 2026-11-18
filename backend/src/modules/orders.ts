import { and, desc, eq, gte, lt, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
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
import type { Principal } from '../domain/access.js';
import {
  orderRange,
  positiveId,
  type OrderReadSelection,
  type OrderListPage,
  type OrderDetail,
  type OrderReadRange,
  type OrderHistoryPort,
} from './order-history/contracts.js';
import { orderCursors } from './order-history/cursor.js';
import { orderReadAuthority } from './order-history/authority.js';
import { publicOrderHistory } from './order-history/reader.js';
import { historyRequired } from './order-history/options.js';
import { sourceOrderDefaults } from './order-history/search/default-ranges.js';
export type { OrderReadSelection } from './order-history/contracts.js';
export interface OrdersService {
  list(
    user: Principal,
    storeId: string,
    before?: string,
    limit?: number,
    selection?: OrderReadSelection,
  ): Promise<OrderListPage>;
  detail(
    user: Principal,
    storeId: string,
    orderId: string,
    selection?: OrderReadSelection,
  ): Promise<OrderDetail>;
}

export function ordersService(
  db: Databases,
  config?: Config,
  history?: OrderHistoryPort,
  clock: () => number = Date.now,
): OrdersService {
  const authorize = orderReadAuthority(db),
    cursors = orderCursors(config?.SESSION_SECRET, clock),
    warehouse = history ?? (config ? publicOrderHistory(config) : undefined);
  const range = (selection: OrderReadSelection = {}, now = clock()) =>
    orderRange(selection, config?.BUSINESS_TIMEZONE ?? 'Asia/Kolkata', now);
  const metadata = (selection: OrderReadRange) => ({
    reader: selection.reader,
    range: selection,
    fetchedAt: new Date(clock()).toISOString(),
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
      if (r.reader === 'bigquery') {
        if (!warehouse) throw historyRequired();
        const response = await warehouse.list({
          storeId,
          range: r,
          before: anchor,
          limit,
          generationId: anchor?.generationId,
        });
        await recheck(user, storeId, version);
        const selected = response.rows.slice(0, limit),
          last = selected.at(-1);
        return {
          ...metadata(r),
          publication: response.evidence,
          data: selected.map(({ header: h, store: s }) => ({
            id: h.id,
            rowId: s.id,
            reference: h.reference,
            storeId,
            customer: `${h.first} ${h.last}`.trim(),
            amount: h.amount,
            status: h.status || '',
            paymentStatus: h.paymentStatus || '',
            createdAt: h.createdAt,
          })),
          nextCursor:
            response.rows.length > limit && last
              ? cursors.encode(
                  scope,
                  { orderId: last.header.id, rowId: last.store.id },
                  response.evidence.generationId,
                )
              : null,
        };
      }
      const rows = await db
        .get(r.reader)
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
        ...metadata(r),
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
      const readTime = clock();
      const selected = range(selection, readTime),
        version = await authorize(user, storeId);
      // The source store list includes its minute-ahead midnight endpoint.
      // Explicit date/report reads retain their ordinary exclusive boundary.
      const sourceEnd =
        !selected.explicit && selected.intent === 'interactive'
          ? sourceOrderDefaults(readTime, selected.timeZone).store.placedTo
          : undefined;
      if (selected.reader !== 'bigquery') {
        const native = await db.get(selected.reader).transaction(
          async (tx) => {
            const [header] = await tx
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
              .where(
                and(
                  eq(OrderStore.store, BigInt(storeId)),
                  eq(Order.id, BigInt(orderId)),
                  gte(Order.created_at, selected.start),
                  sourceEnd && sourceEnd >= selected.end
                    ? lte(Order.created_at, sourceEnd)
                    : lt(Order.created_at, selected.end),
                ),
              )
              .orderBy(OrderStore.id)
              .limit(1);
            if (!header) return null;
            const lines = await tx
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
              .where(eq(HasProduct.order, BigInt(orderId)))
              .orderBy(HasProduct.id);
            return {
              ...metadata(selected),
              id: String(header.id),
              reference: header.reference,
              amount: header.amount,
              createdAt: header.createdAt,
              status: header.status,
              isPaid: header.paymentStatusId === 4n,
              lines: lines.map((l) => ({
                ...l,
                id: String(l.id),
                productId: String(l.productId),
                quantity: String(l.quantity),
              })),
            };
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
        await recheck(user, storeId, version);
        if (native) return native;
        // An explicit current-day selection cannot silently widen to older facts.
        if (selected.explicit)
          throw new AppError(
            404,
            'ORDER_NOT_FOUND',
            'Order not found in this store and date selection.',
          );
      }
      if (!warehouse) throw historyRequired();
      // Unknown-age links first perform only a date-bounded current read. Their
      // fallback is historical BigQuery, never an unrestricted MySQL classifier.
      const result = await warehouse.order({
        source: { kind: 'store', storeId },
        orderId,
        ...(selected.reader === 'bigquery' ? { range: selected } : { cutoff: selected.cutoff }),
      });
      await recheck(user, storeId, version);
      const h = result.header,
        historical =
          selected.reader === 'bigquery'
            ? selected
            : {
                ...range({
                  from: h.createdAt.slice(0, 10),
                  to: h.createdAt.slice(0, 10),
                  intent: selected.intent,
                }),
                explicit: false,
              };
      return {
        ...metadata(historical),
        publication: result.evidence,
        id: h.id,
        reference: h.reference,
        amount: Number(h.amount),
        createdAt: h.createdAt,
        status: h.status,
        isPaid: h.paymentStatusId === '4',
        lines: result.lines.map((l) => ({
          id: l.id,
          productId: l.productId,
          name: l.name,
          quantity: l.quantity,
          amount: Number(l.amount),
          gst: Number(l.gst),
          status: l.status,
        })),
      };
    },
  };
}
