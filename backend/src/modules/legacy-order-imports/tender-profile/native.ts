import { eq, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { Order, OrderStore, HasProduct } from '../../../db/legacy-schema.js';
import { nativeImportOrder } from '../financial-adapter-proof.js';
import { importFinancialError } from '../financial-adapter-crypto.js';
import { nativeTenderFactsSchema } from './domain.js';
import { identifier } from '../../../domain/validation.js';
import { mysqlTable, float } from 'drizzle-orm/mysql-core';

// Verified physical FLOAT is absent from the original Django model mapping.
const physicalTenderOrder = mysqlTable('orders', { rounding: float('fraction_value') });

/** Fixed native expression; no JavaScript reserialization of source DOUBLEs. */
export const csvTenderCounterHashSql =
  "LOWER(SHA2(CAST(JSON_OBJECT('order_id',order_stores.order_id,'store_id',order_stores.store_id,'counter_id',order_stores.counter_id,'is_manually_paid',order_stores.is_manually_paid,'offline_payment',order_stores.offline_payment,'offline_payment_recieved',order_stores.offline_payment_recieved,'online_payment',order_stores.online_payment,'online_other_payment',order_stores.online_other_payment,'transaction_id',order_stores.transaction_id) AS CHAR CHARACTER SET utf8mb4),256))";
const money = (value: string) => new Decimal(value).toFixed(2, Decimal.ROUND_HALF_UP);
/** Internal current-writer facts for the review candidate, not an authorization
 * helper. No API exposes this. Caller must supply its own authority/proof scope. */
export async function readNativeCsvTenderFacts(tx: AdministrationTransaction, orderId: string) {
  identifier.parse(orderId);
  const original = await nativeImportOrder(tx, orderId);
  if (
    original.header.method !== 14n ||
    original.header.paymentStatus !== 4n ||
    original.header.status !== 3n ||
    original.lineStates.some((row) => row.status !== 'PLACED')
  )
    throw importFinancialError('CSV_TENDER_NATIVE_STATE_INVALID');
  const [header] = await tx
    .select({
      payable: sql<string>`CAST(${Order.pay_amt} AS CHAR)`,
      rounding: sql<string>`CAST(${physicalTenderOrder.rounding} AS CHAR)`,
      coupon: sql<string>`CAST(COALESCE(${Order.coupon_amt_used},0) AS CHAR)`,
    })
    .from(Order)
    .where(eq(Order.id, BigInt(orderId)))
    .limit(1)
    .for('share');
  const [counter] = await tx
    .select({
      cash: sql<string>`CAST(${OrderStore.offline_payment} AS CHAR)`,
      received: sql<string>`CAST(${OrderStore.offline_payment_recieved} AS CHAR)`,
      online: sql<string>`CAST(${OrderStore.online_payment} AS CHAR)`,
      manualOther: sql<string>`CAST(${OrderStore.online_other_payment} AS CHAR)`,
      hash: sql<string>`${sql.raw(csvTenderCounterHashSql)}`,
    })
    .from(OrderStore)
    .where(eq(OrderStore.order, BigInt(orderId)))
    .limit(1)
    .for('share');
  const refunds = await tx
    .select({
      amount: sql<string>`CAST(CAST(${HasProduct.amount_to_be_refunded} AS DECIMAL(20,2)) AS CHAR)`,
    })
    .from(HasProduct)
    .where(eq(HasProduct.order, BigInt(orderId)))
    .limit(1001)
    .for('share');
  if (
    !header ||
    !counter ||
    refunds.length !== original.lines.length ||
    refunds.some((row) => !row.amount || new Decimal(row.amount).isNegative())
  )
    throw importFinancialError('CSV_TENDER_NATIVE_STATE_INVALID');
  return nativeTenderFactsSchema.parse({
    orderId,
    headerHash: original.header.headerHash,
    lineHash: original.lineHash,
    counterHash: counter.hash,
    payable: money(header.payable),
    roundingOff: money(header.rounding),
    couponDiscount: money(header.coupon),
    approvedRefundTotal: money(
      refunds.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(),
    ),
    counter: {
      cash: counter.cash,
      received: counter.received,
      online: counter.online,
      manualOther: counter.manualOther,
    },
  });
}
