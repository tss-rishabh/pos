import { datetime, index, int, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { CustomerProfileAdjustmentReceipt } from './contracts.js';

export const customerProfileAdjustments = mysqlTable(
  'pos_rewrite_customer_profile_adjustments',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    checkoutVersion: int('checkout_version').notNull(),
    receipt: json('receipt').$type<CustomerProfileAdjustmentReceipt>().notNull(),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (table) => [index('ix_customer_profile_checkout').on(table.checkoutId, table.createdAt)],
);
