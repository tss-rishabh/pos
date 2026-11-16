import {
  bigint,
  datetime,
  float,
  mysqlTable,
  mysqlEnum,
  text,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';

/** Selected read-only columns from mysql-customer-benefit-schema.json. No legacy DDL. */
export const benefitCustomers = mysqlTable('users', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  email: varchar('email', { length: 96 }).notNull(),
  platform: mysqlEnum('user_platform', ['STORE_FRONT_USER', 'BACK_OFFICE_USER']),
  active: tinyint('status').notNull(),
  blocked: tinyint('is_block'),
  disabled: tinyint('is_disabled'),
  money: float('tss_money').notNull(),
  points: float('tss_points').notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
export const benefitMemberships = mysqlTable('user_eav', {
  entity: varchar('entity', { length: 255 }).notNull(),
  attribute: mysqlEnum('attribute', [
    'EXCLUSIVE_NOTIFY',
    'EXCLUSIVE_EXPIRY',
    'EXCLUSIVE_MEMBER',
  ]).notNull(),
  value: text('value'),
  active: tinyint('is_active'),
});
export const benefitAddons = mysqlTable('user_addons', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  customerId: bigint('user_id', { mode: 'bigint' }),
  isAppUser: tinyint('is_app_user').notNull(),
});
export const benefitVouchers = mysqlTable('gift_vouchers', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  recipient: varchar('to_id', { length: 255 }).notNull(),
  active: tinyint('status').notNull(),
});
