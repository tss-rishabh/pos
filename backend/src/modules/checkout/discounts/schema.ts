import { int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/**
 * Production `store_pg_disc_addons` (tests/golden/schema/production-schema.json), written by
 * `core/tasks.py:271-307` `pg_disc_otp_applied_email`. The rewrite never persists the plaintext OTP.
 */
export const legacyDiscountAddons = mysqlTable('store_pg_disc_addons', {
  id: int('id').autoincrement().primaryKey(),
  orderId: varchar('order_id', { length: 45 }).notNull(),
  description: varchar('pg_disc_desc', { length: 45 }).notNull(),
  amount: int('pg_disc_amount_in_rs'),
  otp: int('pg_disc_otp'),
  providedBy: int('otp_provided_by'),
  providedByName: varchar('otp_provided_by_name', { length: 45 }),
  appliedBy: int('otp_applied_by').notNull(),
  appliedByName: varchar('otp_applied_by_name', { length: 45 }),
  storeId: int('store_id').notNull(),
  counterId: int('counter_id').notNull(),
});
