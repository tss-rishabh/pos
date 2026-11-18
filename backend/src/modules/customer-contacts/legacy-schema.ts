import { bigint, datetime, int, mysqlTable, tinyint, varchar } from 'drizzle-orm/mysql-core';

/** Mapping only: mysql-customer-contact-schema.json +mysql-global-benefits-schema.json. No legacy DDL. */
export const contactUsers = mysqlTable('users', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  email: varchar('email', { length: 96 }).notNull(),
  telephone: varchar('telephone', { length: 32 }).notNull(),
  userType: varchar('user_type', { length: 255 }).notNull(),
  status: tinyint('status').notNull(),
  blocked: tinyint('is_block'),
  disabled: tinyint('is_disabled'),
  emailVerified: int('is_email_verified'),
  twoFactor: tinyint('is_two_fa').notNull(),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
});
