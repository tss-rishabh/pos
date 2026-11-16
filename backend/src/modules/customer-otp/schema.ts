import {
  bigint,
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { CustomerContactBinding } from '../checkout/customer-contact-authority.js';
import type { CustomerOtpScope, CustomerOtpView } from './contracts.js';

export type CustomerOtpState =
  'ACTIVE' | 'VERIFIED' | 'CANCELLED' | 'EXPIRED' | 'LOCKED' | 'SUPERSEDED';
export const customerOtpChallenges = mysqlTable(
  'pos_rewrite_customer_otp_challenges',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    scope: json('scope').$type<CustomerOtpScope>().notNull(),
    contact: json('contact').$type<CustomerContactBinding>().notNull(),
    scopeHash: varchar('scope_hash', { length: 64 }).notNull(),
    activeScopeHash: varchar('active_scope_hash', { length: 64 }),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    actorVersion: varchar('actor_version', { length: 64 }).notNull(),
    state: varchar('state', { length: 16 }).$type<CustomerOtpState>().notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    budgetKeys: json('budget_keys').$type<string[]>().notNull(),
    attempts: int('attempts').notNull().default(0),
    expiresAt: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    proofExpiresAt: bigint('proof_expires_at_ms', { mode: 'number' }).notNull(),
    verifiedUntil: bigint('verified_until_ms', { mode: 'number' }),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_customer_otp_active_scope').on(table.activeScopeHash),
    index('ix_customer_otp_customer_created').on(table.customerId, table.createdAt),
    index('ix_customer_otp_expiry').on(table.state, table.expiresAt, table.id),
  ],
);
export const customerOtpBudgets = mysqlTable('pos_rewrite_customer_otp_budgets', {
  key: varchar('budget_key', { length: 96 }).primaryKey(),
  day: varchar('business_day', { length: 10 }).notNull(),
  sends: int('sends').notNull(),
  failures: int('failures').notNull(),
  windowFailures: int('window_failures').notNull(),
  windowResetAt: bigint('window_reset_at_ms', { mode: 'number' }).notNull(),
  lastSentAt: bigint('last_sent_at_ms', { mode: 'number' }).notNull(),
});
export type CustomerOtpDeliveryState =
  'PENDING' | 'SENDING' | 'ACCEPTED' | 'UNCERTAIN' | 'REJECTED' | 'CANCELLED';
export const customerOtpDeliveries = mysqlTable(
  'pos_rewrite_customer_otp_deliveries',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    challengeId: varchar('challenge_id', { length: 36 }).notNull(),
    channel: varchar('channel', { length: 8 }).$type<'sms' | 'email' | 'whatsapp'>().notNull(),
    availableAt: bigint('available_at_ms', { mode: 'number' }).notNull(),
    state: varchar('state', { length: 16 }).$type<CustomerOtpDeliveryState>().notNull(),
    encryptedPayload: text('encrypted_payload').notNull(),
    leaseToken: varchar('lease_token', { length: 36 }),
    leaseExpiresAt: bigint('lease_expires_at_ms', { mode: 'number' }),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_customer_otp_delivery_channel').on(table.challengeId, table.channel),
    index('ix_customer_otp_delivery_poll').on(table.state, table.availableAt, table.id),
    index('ix_customer_otp_delivery_lease').on(table.state, table.leaseExpiresAt, table.id),
  ],
);
export interface CustomerOtpOutcome {
  result: CustomerOtpView;
  error: 'CUSTOMER_OTP_INVALID' | 'CUSTOMER_OTP_ATTEMPT_LIMIT' | null;
}
export const customerOtpOperations = mysqlTable(
  'pos_rewrite_customer_otp_operations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    challengeId: varchar('challenge_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 16 }).$type<'request' | 'verify'>().notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    outcome: json('outcome').$type<CustomerOtpOutcome>().notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [index('ix_customer_otp_operation_challenge').on(table.challengeId, table.createdAt)],
);
