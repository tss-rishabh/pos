import { bigint, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
/** Read-only projection. Extra INT columns are confirmed by saved live SHOW COLUMNS metadata. */
export const PerformanceOrderStore = mysqlTable('order_stores', {
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  storeId: bigint('store_id', { mode: 'bigint' }).notNull(),
  salespersonId: int('salesperson_id').notNull(),
  adminUserId: int('admin_user_id').notNull(),
  performanceJson: varchar('performance_json', { length: 255 }).notNull(),
});
