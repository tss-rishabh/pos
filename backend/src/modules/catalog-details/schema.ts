import { bigint, float, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

// Read-only projections of physical legacy tables. Never auto-migrate these tables.
export const catalogProductTypes = mysqlTable('product_types', {
  id: bigint('id', { mode: 'bigint', unsigned: true }).primaryKey().notNull(),
  type: varchar('type', { length: 50 }).notNull(),
});
export const catalogCategories = mysqlTable('categories', {
  id: bigint('id', { mode: 'bigint', unsigned: true }).primaryKey(),
  category: varchar('category', { length: 50 }).notNull(),
});
/**
 * `pricelist` with its `location_id` primary-key member, which the snapshot orders by. The shared
 * `PriceList` definition does not declare it. `price` keeps the driver's FLOAT number.
 */
export const catalogPriceList = mysqlTable('pricelist', {
  product_id: bigint('product_id', { mode: 'bigint' }).primaryKey().notNull(),
  pricelist_id: int('pricelist_id').primaryKey().notNull(),
  price: float('price'),
  location_id: int('location_id').primaryKey().notNull(),
});
