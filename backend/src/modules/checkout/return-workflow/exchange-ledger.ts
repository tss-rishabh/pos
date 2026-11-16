import { bigint, datetime, mysqlTable, tinyint, varchar } from 'drizzle-orm/mysql-core';

/** Upstream models/Order.py ExchangeOrderLog; verified live columns are tracked in backend/evidence. */
export const exchangeOrderLog = mysqlTable('exchange_order_log', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  parentOrderId: bigint('parent_order_id', { mode: 'bigint' }).notNull(),
  parentLineId: bigint('parent_has_product_id', { mode: 'bigint' }).notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  lineId: bigint('has_product_id', { mode: 'bigint' }).notNull(),
  isUnhold: tinyint('is_unhold').notNull().default(0),
  returnAwb: varchar('return_awb', { length: 25 }).notNull().default(''),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
});
