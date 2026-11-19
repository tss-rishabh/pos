import { datetime, index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { ReturnOperation } from './contracts.js';
import type { ReturnVerification } from './verification-state.js';
export type { ReturnVerification } from './verification-state.js';

/*
 * COMPATIBILITY ONLY — the return workflow no longer reads or writes these rewrite tables.
 * Operation state, verification proofs and recovery claims live in Redis (state.ts); durable
 * facts are written to the legacy production tables. These definitions remain exported only for
 * modules outside checkout/return-workflow that still import them (legacy-order-status,
 * payment-reversals, customer-otp, checkout/worker via outbox.ts) until their owners migrate.
 * Freed tables: pos_rewrite_return_operations, pos_rewrite_return_outbox,
 * pos_rewrite_return_verifications, pos_rewrite_return_verification_limits,
 * pos_rewrite_exchange_recovery_claims, pos_rewrite_exchange_stock_confirmations.
 */

/** @deprecated Redis `pos:return_op:{id}` (state.ts). */
export const returnOperations = mysqlTable(
  'pos_rewrite_return_operations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    lineId: varchar('line_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    phase: varchar('phase', { length: 32 }).notNull(),
    state: json('state').$type<ReturnOperation>().notNull(),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
  },
  (table) => [index('ix_return_line_phase').on(table.lineId, table.phase)],
);
/** @deprecated Return/exchange mail is sent inline after commit, as legacy does. */
export const returnOutbox = mysqlTable('pos_rewrite_return_outbox', {
  id: varchar('id', { length: 36 }).primaryKey(),
  kind: varchar('kind', { length: 32 }).notNull(),
  orderId: varchar('order_id', { length: 32 }).notNull(),
  storeId: varchar('store_id', { length: 32 }).notNull(),
  productId: varchar('product_id', { length: 32 }).notNull(),
  lineId: varchar('line_id', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  requestId: varchar('request_id', { length: 128 }),
  operatorId: varchar('operator_id', { length: 32 }),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
/** @deprecated Redis `pos:return_verification:{id}`; read it with `readReturnVerification`. */
export const returnVerifications = mysqlTable('pos_rewrite_return_verifications', {
  id: varchar('id', { length: 36 }).primaryKey(),
  state: json('state').$type<ReturnVerification>().notNull(),
});
