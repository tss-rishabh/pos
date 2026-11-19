import { and, asc, eq, gte, inArray, like, lte } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Databases } from '../../db/pools.js';
import {
  Comments,
  HasProduct,
  Order,
  OrderStore,
  PosPaytmTransaction,
  PosTerminalTransaction,
} from '../../db/legacy-schema.js';

export interface OfflineOrder {
  orderId: string;
  storeId: string;
  counterId: string;
  invoiceNumber: string | null;
  paid: boolean;
  payable: string;
}
/** matched: a terminal row for this store and reference with the same amount, unattached or
 * attached to this order. mismatch: rows exist but none qualifies. missing: no row. */
export type TenderMatch = 'matched' | 'mismatch' | 'missing';
export interface ReconciliationFlag {
  orderId: string;
  reference: string;
  mode: 'card' | 'upi';
  tenderReference: string;
  match: Exclude<TenderMatch, 'matched'>;
  userId: string;
}
/** Legacy-style comment that flags a manually entered card/UPI reference for finance. The
 * prefix differs from the billing comment ('... billed at '), so neither matches the other. */
export function reconciliationPrefix(reference: string): string {
  return `Offline bill ${reference} reconciliation: `;
}
export function reconciliationComment(
  flag: Omit<ReconciliationFlag, 'orderId' | 'userId'>,
): string {
  return (
    reconciliationPrefix(flag.reference) +
    `${flag.mode.toUpperCase()} reference ${flag.tenderReference} ` +
    (flag.match === 'missing'
      ? 'has no matching terminal transaction. Finance to reconcile.'
      : 'does not match the terminal transaction amount or order. Finance to reconcile.')
  );
}
/** An existing order a manager links to an offline sale whose outcome was unknown. */
export interface OfflineLinkCandidate {
  order: OfflineOrder;
  createdAt: string;
  lines: { productId: string; quantity: number }[];
  /** Comment texts on the order that already carry an offline provisional reference. */
  offlineComments: string[];
}
export interface OfflineReferenceComment {
  orderId: string;
  reference: string;
  billedAt: number;
  userId: string;
}

/** Legacy-style comment text. The provisional reference is followed by a
 * space, so the fallback prefix never matches a longer sequence number. */
export function offlineCommentPrefix(reference: string): string {
  return `Offline bill ${reference} billed at `;
}
export function offlineComment(reference: string, billedAt: number): string {
  return offlineCommentPrefix(reference) + new Date(billedAt).toISOString();
}

/** Existing production tables only (schema freeze). the order reference number is
 * owned by API-v2 (shipment/finance tracking number) and is never written. */
export interface OfflineSyncRepository {
  order(orderId: string): Promise<OfflineOrder | null>;
  /** Durable fallback when the Redis record is missing: the legacy comment row. */
  findByComment(
    reference: string,
    userIds: string[],
    from: number,
    to: number,
  ): Promise<OfflineOrder | null>;
  commentExists(orderId: string, reference: string): Promise<boolean>;
  linkCandidate(orderId: string): Promise<OfflineLinkCandidate | null>;
  recordReference(input: OfflineReferenceComment): Promise<void>;
  /** Terminal-table check of a manually entered card/UPI reference (finance reconciliation). */
  tenderMatch(input: {
    storeId: string;
    orderId: string;
    reference: string;
    amount: string;
  }): Promise<TenderMatch>;
  reconciliationFlagged(orderId: string, reference: string): Promise<boolean>;
  flagReconciliation(input: ReconciliationFlag): Promise<void>;
}

/** pay_amt is a MySQL double; render it to exactly two decimals without
 * binary-float drift for the payment split validation. */
export function payableText(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid payable.');
  return (Math.round(value * 100) / 100).toFixed(2);
}

export function offlineSyncRepository(db: Databases, timezone: string): OfflineSyncRepository {
  const local = (epochMs: number) =>
    Temporal.Instant.fromEpochMilliseconds(epochMs)
      .toZonedDateTimeISO(timezone)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const columns = {
    orderId: Order.id,
    payment: Order.payment_statuses,
    payable: Order.pay_amt,
    storeId: OrderStore.store,
    counterId: OrderStore.counter,
    invoice: OrderStore.order_invoice,
  };
  const toOrder = (row: {
    orderId: bigint;
    payment: bigint | null;
    payable: number;
    storeId: bigint;
    counterId: bigint;
    invoice: string | null;
  }): OfflineOrder => ({
    orderId: String(row.orderId),
    storeId: String(row.storeId),
    counterId: String(row.counterId),
    invoiceNumber: row.invoice || null,
    paid: row.payment === 4n,
    payable: payableText(row.payable),
  });
  return {
    async order(orderId) {
      const [row] = await db
        .get('writer')
        .select(columns)
        .from(Order)
        .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
        .where(eq(Order.id, BigInt(orderId)))
        .limit(1);
      return row ? toOrder(row) : null;
    },
    async findByComment(reference, userIds, from, to) {
      const prefix = offlineCommentPrefix(reference).replace(/[\\%_]/g, (match) => '\\' + match);
      const rows = await db
        .get('writer')
        .select(columns)
        .from(Comments)
        .innerJoin(Order, eq(Order.id, Comments.order_id))
        .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
        .where(
          and(
            inArray(
              Comments.user_id,
              userIds.map((id) => BigInt(id)),
            ),
            gte(Comments.created_at, local(from)),
            lte(Comments.created_at, local(to)),
            like(Comments.comment, `${prefix}%`),
          ),
        )
        .orderBy(asc(Comments.id))
        .limit(2);
      const orders = new Set(rows.map((row) => String(row.orderId)));
      return rows[0] && orders.size === 1 ? toOrder(rows[0]) : null;
    },
    async linkCandidate(orderId) {
      const writer = db.get('writer'),
        id = BigInt(orderId);
      const [row] = await writer
        .select({ ...columns, createdAt: Order.created_at })
        .from(Order)
        .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
        .where(eq(Order.id, id))
        .limit(1);
      if (!row) return null;
      const lines = await writer
        .select({ productId: HasProduct.product, quantity: HasProduct.qty })
        .from(HasProduct)
        .where(eq(HasProduct.order, id))
        .orderBy(asc(HasProduct.id));
      const comments = await writer
        .select({ comment: Comments.comment })
        .from(Comments)
        .where(and(eq(Comments.order_id, id), like(Comments.comment, 'Offline bill %')))
        .orderBy(asc(Comments.id))
        .limit(10);
      return {
        order: toOrder(row),
        createdAt: String(row.createdAt ?? ''),
        lines: lines.map((line) => ({
          productId: String(line.productId),
          quantity: Number(line.quantity),
        })),
        offlineComments: comments.map((item) => item.comment),
      };
    },
    async commentExists(orderId, reference) {
      const prefix = offlineCommentPrefix(reference).replace(/[\\%_]/g, (match) => '\\' + match);
      const [row] = await db
        .get('writer')
        .select({ id: Comments.id })
        .from(Comments)
        .where(and(eq(Comments.order_id, BigInt(orderId)), like(Comments.comment, `${prefix}%`)))
        .limit(1);
      return Boolean(row);
    },
    async recordReference(input) {
      const timestamp = local(Date.now());
      await db.get('writer').transaction(async (tx) => {
        const [order] = await tx
          .select({ status: Order.order_statuses })
          .from(Order)
          .where(eq(Order.id, BigInt(input.orderId)))
          .limit(1)
          .for('update');
        if (!order) throw new RangeError('The created order was not found.');
        // Legacy Comments.objects.create shape (order/libs/calculations.py add_to_comment).
        await tx.insert(Comments).values({
          order_id: BigInt(input.orderId),
          status_id: order.status ?? 0n,
          comment: offlineComment(input.reference, input.billedAt),
          notify: 0,
          user_id: BigInt(input.userId),
          package_details: '',
          has_product_id: 0n,
          prod_id: 0n,
          created_at: timestamp,
          updated_at: timestamp,
        });
        await tx
          .update(OrderStore)
          .set({ is_offline_order: true })
          .where(eq(OrderStore.order, BigInt(input.orderId)));
      });
    },
    async tenderMatch({ storeId, orderId, reference, amount }) {
      const writer = db.get('writer');
      const select = (table: typeof PosTerminalTransaction | typeof PosPaytmTransaction) =>
        writer
          .select({ orderId: table.order_id, amount: table.amount })
          .from(table)
          .where(and(eq(table.store_id, BigInt(storeId)), eq(table.transaction_id, reference)))
          .limit(20);
      const rows = [
        ...(await select(PosTerminalTransaction)),
        ...(await select(PosPaytmTransaction)),
      ];
      if (!rows.length) return 'missing';
      const expected = Math.round(Number(amount) * 100);
      return rows.some(
        (row) =>
          Math.round(Number(row.amount) * 100) === expected &&
          (row.orderId === 0n || String(row.orderId) === orderId),
      )
        ? 'matched'
        : 'mismatch';
    },
    async reconciliationFlagged(orderId, reference) {
      const prefix = reconciliationPrefix(reference).replace(/[\\%_]/g, (match) => '\\' + match);
      const [row] = await db
        .get('writer')
        .select({ id: Comments.id })
        .from(Comments)
        .where(and(eq(Comments.order_id, BigInt(orderId)), like(Comments.comment, `${prefix}%`)))
        .limit(1);
      return Boolean(row);
    },
    async flagReconciliation(flag) {
      const timestamp = local(Date.now());
      await db.get('writer').transaction(async (tx) => {
        const [order] = await tx
          .select({ status: Order.order_statuses })
          .from(Order)
          .where(eq(Order.id, BigInt(flag.orderId)))
          .limit(1)
          .for('update');
        if (!order) throw new RangeError('The created order was not found.');
        await tx.insert(Comments).values({
          order_id: BigInt(flag.orderId),
          status_id: order.status ?? 0n,
          comment: reconciliationComment(flag),
          notify: 0,
          user_id: BigInt(flag.userId),
          package_details: '',
          has_product_id: 0n,
          prod_id: 0n,
          created_at: timestamp,
          updated_at: timestamp,
        });
      });
    },
  };
}
