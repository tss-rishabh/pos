import { bigint, datetime, index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { ReturnOperation } from './contracts.js';
import type { CustomerContactBinding } from '../customer-contact-authority.js';
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
export interface ReturnVerification {
  id: string;
  operatorId: string;
  storeId: string;
  counterId: string;
  orderId: string;
  customerId: string;
  requestHash: string;
  sent: boolean;
  expiresAt: number;
  verifiedUntil: number | null;
  busyOperationId: string | null;
  contact?: CustomerContactBinding | null;
  otpChallengeId?: string | null;
  deliveryStatus?: 'pending' | 'sent' | 'uncertain' | 'rejected' | null;
  requestOperationId?: string | null;
  verifyOperationId?: string | null;
  verificationError?: string | null;
}
export const returnVerifications = mysqlTable('pos_rewrite_return_verifications', {
  id: varchar('id', { length: 36 }).primaryKey(),
  state: json('state').$type<ReturnVerification>().notNull(),
});
export const returnVerificationLimits = mysqlTable('pos_rewrite_return_verification_limits', {
  customerId: varchar('customer_id', { length: 32 }).primaryKey(),
  state: json('state').$type<{ nextSendAt: number; attempts: number; resetAt: number }>().notNull(),
  updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
});
