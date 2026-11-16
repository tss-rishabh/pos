import {
  bigint,
  int,
  json,
  mysqlTable,
  primaryKey,
  timestamp,
  varchar,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';
import type { CheckoutState, MutationResult } from './contracts.js';

export const checkoutSessions = mysqlTable(
  'pos_rewrite_checkout_sessions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    clientDraftId: varchar('client_draft_id', { length: 36 }),
    version: int('version').notNull(),
    state: json('state').$type<CheckoutState>().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [uniqueIndex('ux_checkout_operator_draft').on(table.operatorId, table.clientDraftId)],
);
export const checkoutOperations = mysqlTable(
  'pos_rewrite_checkout_operations',
  {
    checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
    id: varchar('id', { length: 36 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    result: json('result').$type<MutationResult>(),
    errorCode: varchar('error_code', { length: 64 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.checkoutId, table.id] })],
);
export const customerLeases = mysqlTable('pos_rewrite_customer_cart_leases', {
  customerId: varchar('customer_id', { length: 32 }).primaryKey(),
  checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
  expiresAt: bigint('expires_at_ms', { mode: 'number' }).notNull(),
});
export const giftCardLeases = mysqlTable('pos_rewrite_gift_card_leases', {
  serial: varchar('serial', { length: 32 }).primaryKey(),
  checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
  expiresAt: bigint('expires_at_ms', { mode: 'number' }).notNull(),
});
