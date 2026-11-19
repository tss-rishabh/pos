import { bigint, datetime, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/** Rewrite-owned state. These declarations never migrate legacy tables. */
export const administrationRegistries = mysqlTable('pos_rewrite_administration_registries', {
  resource: varchar('resource', { length: 32 }).primaryKey(),
});
export const operatorCheckIns = mysqlTable('pos_rewrite_operator_checkins', {
  operatorId: varchar('operator_id', { length: 32 }).primaryKey(),
  storeId: bigint('store_id', { mode: 'bigint', unsigned: true }).notNull(),
  counterId: bigint('counter_id', { mode: 'bigint', unsigned: true }),
  expiresAt: datetime('expires_at', { mode: 'string', fsp: 3 }).notNull(),
  checkedInAt: datetime('checked_in_at', { mode: 'string', fsp: 3 }).notNull(),
});
