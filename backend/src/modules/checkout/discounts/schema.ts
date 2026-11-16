import { bigint, datetime, int, json, mysqlTable, varchar, index } from 'drizzle-orm/mysql-core';
import type { DiscountChallenge } from './contracts.js';

export const discountChallenges = mysqlTable('pos_rewrite_discount_approvals', {
  checkoutId: varchar('checkout_id', { length: 36 }).primaryKey(),
  state: json('state').$type<DiscountChallenge>().notNull(),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
});
export const discountApprovalLimits = mysqlTable('pos_rewrite_discount_approval_limits', {
  operatorId: varchar('operator_id', { length: 32 }).primaryKey(),
  lastSentAt: bigint('last_sent_at_ms', { mode: 'number' }).notNull(),
  windowStartedAt: bigint('window_started_at_ms', { mode: 'number' }).notNull(),
  attempts: int('verification_attempts').notNull(),
});
export const discountDeliveries = mysqlTable(
  'pos_rewrite_discount_deliveries',
  {
    id: varchar('id', { length: 80 }).primaryKey(),
    checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
    challengeId: varchar('challenge_id', { length: 36 }),
    orderId: varchar('order_id', { length: 32 }),
    targetId: varchar('target_id', { length: 32 }).notNull(),
    kind: varchar('kind', { length: 20 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    encryptedCode: varchar('encrypted_code', { length: 256 }),
    requestId: varchar('request_id', { length: 128 }),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (table) => [
    index('ix_discount_delivery_poll').on(table.status, table.createdAt, table.id),
    index('ix_discount_delivery_challenge').on(table.checkoutId, table.challengeId, table.status),
  ],
);
export const discountAudits = mysqlTable('pos_rewrite_discount_audits', {
  orderId: varchar('order_id', { length: 32 }).primaryKey(),
  checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
  approvalId: varchar('approval_id', { length: 36 }),
  approvedBy: varchar('approved_by', { length: 32 }),
  appliedBy: varchar('applied_by', { length: 32 }).notNull(),
  amount: varchar('amount', { length: 16 }).notNull(),
  comment: varchar('comment', { length: 45 }).notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
/** Columns verified read-only in evidence/mysql-extra-schema.json. Never persist a plaintext OTP. */
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
