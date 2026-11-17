import {
  char,
  date,
  datetime,
  index,
  json,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { CashReturnClaimBody } from './intent-claim-contracts.js';
export const cashReturnClaims = mysqlTable(
  'pos_rewrite_cash_return_claims',
  {
    id: char('id', { length: 36 }).primaryKey(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    originalPaymentId: char('original_payment_id', { length: 36 }).notNull(),
    cashReturnReceiptId: char('cash_return_receipt_id', { length: 36 }).notNull(),
    body: json('body').$type<CashReturnClaimBody>().notNull(),
    bodyHash: char('body_hash', { length: 64 }).notNull(),
    impactFrom: date('impact_from', { mode: 'string' }).notNull(),
    createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
  },
  (table) => [
    uniqueIndex('cash_return_claim_payment').on(table.originalPaymentId),
    uniqueIndex('cash_return_claim_receipt').on(table.cashReturnReceiptId),
    index('cash_return_claim_store').on(table.storeId, table.id),
    index('cash_return_claim_order').on(table.orderId, table.id),
  ],
);
export const cashReturnClaimResolutions = mysqlTable('pos_rewrite_cash_return_claim_resolutions', {
  id: char('id', { length: 36 }).primaryKey(),
  actorId: varchar('actor_id', { length: 32 }).notNull(),
  sessionHash: char('session_hash', { length: 64 }).notNull(),
  receiptHash: char('receipt_hash', { length: 64 }).notNull(),
  proofHash: char('proof_hash', { length: 64 }).notNull(),
  recordedAt: datetime('recorded_at', { mode: 'string', fsp: 3 }).notNull(),
  requestId: varchar('request_id', { length: 128 }),
});
