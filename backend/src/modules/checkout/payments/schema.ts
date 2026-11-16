import {
  datetime,
  json,
  mysqlTable,
  varchar,
  index,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';
import type { PaymentAttempt } from './contracts.js';
export const paymentAttempts = mysqlTable(
  'pos_rewrite_payment_attempts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    state: json('state').$type<PaymentAttempt>().notNull(),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
  },
  (table) => [index('ix_payment_order_status').on(table.orderId, table.status)],
);
export const paymentOutbox = mysqlTable(
  'pos_rewrite_payment_outbox',
  {
    id: varchar('id', { length: 80 }).primaryKey(),
    kind: varchar('kind', { length: 32 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    operatorId: varchar('operator_id', { length: 32 }),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (table) => [
    index('ix_payment_outbox_pending').on(table.status, table.createdAt, table.id, table.kind),
  ],
);

/** An original terminal dispatch can be adopted once; adoption never dispatches another charge. */
export const legacyPaymentRecoveries = mysqlTable(
  'pos_rewrite_legacy_payment_recoveries',
  {
    provider: varchar('provider', { length: 8 }).notNull(),
    legacyId: varchar('legacy_id', { length: 32 }).notNull(),
    attemptId: varchar('attempt_id', { length: 36 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.legacyId] }),
    uniqueIndex('uq_legacy_payment_attempt').on(table.attemptId),
    index('ix_legacy_payment_order').on(table.orderId),
  ],
);
