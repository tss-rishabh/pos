import { bigint, datetime, int, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';

// Physical types/defaults verified through read-only SHOW FULL COLUMNS; never schema-pushed.
export const aggregateStock = mysqlTable('product_stocks', {
  productId: bigint('prod_id', { mode: 'bigint', unsigned: true }).primaryKey(),
  parentProductId: bigint('parent_prod_id', { mode: 'bigint' }),
  stock: bigint('stock', { mode: 'bigint' }).notNull(),
  buffer: int('stocked').notNull(),
});
export const physicalStockLog = mysqlTable('product_inventory_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  productId: bigint('product_id', { mode: 'bigint' }).notNull(),
  before: int('tss_stock').notNull(),
  after: int('vinc_stock').notNull(),
  location: varchar('location', { length: 55 }).notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
});
export const storeStockLog = mysqlTable('pos_inventory_sync_log', {
  id: bigint('id', { mode: 'bigint', unsigned: true }).autoincrement().primaryKey(),
  storeId: bigint('store_id', { mode: 'bigint', unsigned: true }).notNull(),
  productId: bigint('product_id', { mode: 'bigint', unsigned: true }).notNull(),
  before: int('tss_stock').notNull(),
  after: int('pos_stock').notNull(),
  syncedAt: datetime('sycned_at', { mode: 'string' }).notNull(),
});
export const aggregateStockLog = mysqlTable('products_inventory_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull(),
  before: text('stock_before').notNull(),
  after: text('stock_after').notNull(),
  location: varchar('location', { length: 55 }),
  storeStock: int('store_addon_stock').notNull(),
  finalStock: int('final_stock').notNull(),
  type: int('type').notNull(),
  userId: bigint('user_id', { mode: 'bigint' }).notNull(),
  comment: text('comment').notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
  heldStock: int('hold_stock').notNull(),
});
