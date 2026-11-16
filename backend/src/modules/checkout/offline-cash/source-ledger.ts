import {
  bigint,
  datetime,
  float,
  int,
  mysqlTable,
  text,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';

/** Physical legacy audit projections; caller writes them in the order transaction. */
export const cashFlagHistory = mysqlTable('flag_history', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  flagId: bigint('flag_id', { mode: 'bigint' }).notNull(),
  comment: text('f_comment').notNull(),
  customerId: bigint('user_id', { mode: 'bigint' }).notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
});
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
export const cashCancellationMessages = mysqlTable('order_cancel_message_mapping', {
  id: int('id').autoincrement().primaryKey(),
  messageId: tinyint('message_id').notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
});
