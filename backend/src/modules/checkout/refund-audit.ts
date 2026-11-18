import { bigint, datetime, float, mysqlTable, tinyint, varchar } from 'drizzle-orm/mysql-core';

/**
 * Physical `amount_to_be_refunded_log` projection used by the refund-allocation,
 * cancellation and payment-reversal guards. `is_refunded` stays a raw tinyint so
 * any non-zero stored value is treated as refunded, as the callers require.
 */
export const cashRefundAudit = mysqlTable('amount_to_be_refunded_log', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull(),
  lineId: bigint('has_product_id', { mode: 'bigint' }),
  points: float('tss_point_used').notNull(),
  money: float('tss_money_used').notNull(),
  voucher: float('gift_voucher_amount').notNull(),
  coupon: float('coupon_amt_used').notNull(),
  pg: float('pg_disc'),
  storeDiscount: float('store_disc_pg').notNull(),
  refundable: float('amount_to_be_refunded').notNull(),
  isRefunded: tinyint('is_refunded'),
  refunded: float('refunded_amt').notNull(),
  refundMode: varchar('refund_mode', { length: 45 }),
  comment: varchar('comment', { length: 127 }),
  createdAt: datetime('created_at', { mode: 'string' }),
  updatedAt: datetime('updated_at', { mode: 'string' }),
});
