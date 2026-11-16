import { bigint, double, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
/** Source unmanaged has_product_id is BIGINT NULL in verified live metadata. Read-only. */
export const ReturnReportMoneyHistory = mysqlTable('tss_money_history', {
  orderId: int('order_id').notNull(),
  hasProductId: bigint('has_product_id', { mode: 'bigint' }),
  platform: varchar('platform', { length: 255 }).notNull(),
  addedAmount: double('added_amt').notNull(),
});
