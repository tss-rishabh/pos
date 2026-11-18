import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import {
  Order,
  OrderStore,
  PosPaytmTransaction,
  PosTerminalTransaction,
  TssSetting,
} from '../../db/legacy-schema.js';

export const OFFLINE_LIMIT_KEYS = {
  maxMinutes: 'POS_OFFLINE_BILLING_MAX_MINUTES',
  maxOrders: 'POS_OFFLINE_BILLING_MAX_ORDERS',
} as const;

export interface ExistingOfflineOrder {
  orderId: string;
  storeId: string;
  counterId: string;
  invoiceNumber: string | null;
  paid: boolean;
  payable: string;
}

/** Existing production tables only (schema freeze). Idempotency, authorization
 * confirmation and stamping read/write the writer for consistency. */
export interface OfflineSyncRepository {
  findByReference(reference: string): Promise<ExistingOfflineOrder[]>;
  stampReference(orderId: string, reference: string): Promise<void>;
  tenderReferenceExists(storeId: string, reference: string): Promise<boolean>;
  settings(): Promise<Record<string, string | null>>;
}

/** pay_amt is a MySQL double; render it to exactly two decimals without
 * binary-float drift for the payment split validation. */
export function payableText(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid payable.');
  return (Math.round(value * 100) / 100).toFixed(2);
}

export function offlineSyncRepository(db: Databases): OfflineSyncRepository {
  return {
    async findByReference(reference) {
      const rows = await db
        .get('writer')
        .select({
          orderId: Order.id,
          payment: Order.payment_statuses,
          payable: Order.pay_amt,
          storeId: OrderStore.store,
          counterId: OrderStore.counter,
          invoice: OrderStore.order_invoice,
        })
        .from(Order)
        .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
        .where(eq(Order.order_ref_no, reference))
        .orderBy(asc(Order.id))
        .limit(2);
      return rows.map((row) => ({
        orderId: String(row.orderId),
        storeId: String(row.storeId),
        counterId: String(row.counterId),
        invoiceNumber: row.invoice || null,
        paid: row.payment === 4n,
        payable: payableText(row.payable),
      }));
    },
    async stampReference(orderId, reference) {
      await db.get('writer').transaction(async (tx) => {
        await tx
          .update(Order)
          .set({ order_ref_no: reference })
          .where(eq(Order.id, BigInt(orderId)));
        await tx
          .update(OrderStore)
          .set({ is_offline_order: true })
          .where(eq(OrderStore.order, BigInt(orderId)));
      });
    },
    async tenderReferenceExists(storeId, reference) {
      const writer = db.get('writer');
      const [terminal] = await writer
        .select({ id: PosTerminalTransaction.id })
        .from(PosTerminalTransaction)
        .where(
          and(
            eq(PosTerminalTransaction.store_id, BigInt(storeId)),
            eq(PosTerminalTransaction.transaction_id, reference),
          ),
        )
        .limit(1);
      if (terminal) return true;
      const [paytm] = await writer
        .select({ id: PosPaytmTransaction.id })
        .from(PosPaytmTransaction)
        .where(
          and(
            eq(PosPaytmTransaction.store_id, BigInt(storeId)),
            eq(PosPaytmTransaction.transaction_id, reference),
          ),
        )
        .limit(1);
      return Boolean(paytm);
    },
    async settings() {
      // Same as legacy TssSetting.objects.filter(platform=...).first().
      const rows = await db
        .get('primary')
        .select({ platform: TssSetting.platform, value: TssSetting.value })
        .from(TssSetting)
        .where(inArray(TssSetting.platform, Object.values(OFFLINE_LIMIT_KEYS)))
        .orderBy(asc(TssSetting.id));
      const result: Record<string, string | null> = {};
      for (const row of rows)
        if (row.platform && !(row.platform in result)) result[row.platform] = row.value;
      return result;
    },
  };
}
