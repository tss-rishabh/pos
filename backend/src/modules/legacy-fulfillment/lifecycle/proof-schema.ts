import { bigint, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
/** Additional physical projection from mysql-legacy-cancellations-schema.json. Never migrated. */
export const cancellationRows = mysqlTable('cancel_orders', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull(),
  subProductId: bigint('sub_prod_id', { mode: 'bigint' }).notNull(),
  quantity: int('qty').notNull(),
  hasProductId: bigint('has_product_id', { mode: 'bigint' }),
  status: int('order_status').notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
export const refundLineState = mysqlTable('has_products', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  status: varchar('status', { length: 55 }).notNull(),
});
