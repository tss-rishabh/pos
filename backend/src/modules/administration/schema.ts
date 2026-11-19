import { bigint, datetime, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/**
 * @deprecated Check-ins live in the legacy Redis keys `check_in_{uid}` /
 * `check_in_list_{store}` (`checkins.ts`). Nothing in `src/` reads or writes this table; the
 * export remains only for `tests/fulfillment/mysql.integration.test.ts` (outside W8a).
 */
export const operatorCheckIns = mysqlTable('pos_rewrite_operator_checkins', {
  operatorId: varchar('operator_id', { length: 32 }).primaryKey(),
  storeId: bigint('store_id', { mode: 'bigint', unsigned: true }).notNull(),
  counterId: bigint('counter_id', { mode: 'bigint', unsigned: true }),
  expiresAt: datetime('expires_at', { mode: 'string', fsp: 3 }).notNull(),
  checkedInAt: datetime('checked_in_at', { mode: 'string', fsp: 3 }).notNull(),
});
