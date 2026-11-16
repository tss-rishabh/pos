import { bigint, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

// Read-only projections of physical legacy tables. Never auto-migrate these tables.
export const catalogProductTypes = mysqlTable('product_types', {
  id: bigint('id', { mode: 'bigint', unsigned: true }).primaryKey().notNull(),
  type: varchar('type', { length: 50 }).notNull(),
});
export const catalogCategories = mysqlTable('categories', {
  id: bigint('id', { mode: 'bigint', unsigned: true }).primaryKey(),
  category: varchar('category', { length: 50 }),
});
