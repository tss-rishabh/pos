import {
  bigint,
  index,
  int,
  json,
  mediumtext,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

export const contactStatuses = [
  'PENDING_CURRENT',
  'PENDING_NEW',
  'READY',
  'COMMITTING',
  'COMMITTED',
  'CANCELLED',
  'EXPIRED',
  'LOCKED',
  'UNCERTAIN',
] as const;
export type CustomerContactStatus = (typeof contactStatuses)[number];
export type CustomerContactStage = 'current' | 'new';
export const customerContactChallenges = mysqlTable(
  'pos_rewrite_customer_contact_challenges',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    activeCustomerId: varchar('active_customer_id', { length: 32 }),
    actorVersion: varchar('actor_version', { length: 64 }).notNull(),
    contactFingerprint: varchar('contact_fingerprint', { length: 64 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    kind: varchar('kind', { length: 16 }).$type<'telephone' | 'email'>().notNull(),
    targetKey: varchar('target_key', { length: 70 }).notNull(),
    encryptedInput: text('encrypted_input').notNull(),
    status: varchar('status', { length: 24 }).$type<CustomerContactStatus>().notNull(),
    version: int('version').notNull(),
    stage: varchar('stage', { length: 8 }).$type<CustomerContactStage>().notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    codeExpiresAt: bigint('code_expires_at_ms', { mode: 'number' }).notNull(),
    attempts: int('attempts').notNull(),
    currentVerifiedAt: bigint('current_verified_at_ms', { mode: 'number' }),
    newVerifiedAt: bigint('new_verified_at_ms', { mode: 'number' }),
    expiresAt: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    retryAt: bigint('retry_at_ms', { mode: 'number' }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_customer_contact_active_customer').on(table.activeCustomerId),
    index('ix_customer_contact_checkout').on(table.checkoutId, table.createdAt),
    index('ix_customer_contact_expiry').on(table.status, table.expiresAt),
  ],
);
/** Perpetual lock rows are never deleted; every cooperating creator locks the same contact namespace. */
export const customerContactMutexes = mysqlTable('pos_rewrite_customer_contact_mutexes', {
  key: varchar('contact_key', { length: 70 }).primaryKey(),
});
export const customerContactReservations = mysqlTable(
  'pos_rewrite_customer_contact_reservations',
  {
    key: varchar('contact_key', { length: 70 }).primaryKey(),
    challengeId: varchar('challenge_id', { length: 36 }).notNull(),
    expiresAt: bigint('expires_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [index('ix_customer_contact_reservation_owner').on(table.challengeId)],
);
export const customerContactLimits = mysqlTable('pos_rewrite_customer_contact_limits', {
  key: varchar('limit_key', { length: 96 }).primaryKey(),
  day: varchar('budget_day', { length: 10 }).notNull(),
  sends: int('sends').notNull(),
  failures: int('failures').notNull(),
  lastSentAt: bigint('last_sent_at_ms', { mode: 'number' }).notNull(),
});
export type ContactDeliveryKind = 'otp' | 'source-effects';
export const customerContactDeliveries = mysqlTable(
  'pos_rewrite_customer_contact_deliveries',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    challengeId: varchar('challenge_id', { length: 36 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    kind: varchar('kind', { length: 24 }).$type<ContactDeliveryKind>().notNull(),
    stage: varchar('stage', { length: 8 }).$type<CustomerContactStage>(),
    encryptedPayload: mediumtext('encrypted_payload').notNull(),
    status: varchar('status', { length: 16 })
      .$type<'PENDING' | 'SENDING' | 'DELIVERED' | 'UNCERTAIN' | 'REJECTED' | 'CANCELLED'>()
      .notNull(),
    attempts: int('attempts').notNull(),
    leaseToken: varchar('lease_token', { length: 36 }),
    leaseExpiresAt: bigint('lease_expires_at_ms', { mode: 'number' }),
    expiresAt: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('ix_customer_contact_delivery_pending').on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
    index('ix_customer_contact_delivery_owner').on(table.challengeId, table.stage),
    index('ix_customer_contact_delivery_expiry').on(table.kind, table.expiresAt, table.id),
  ],
);
export interface ContactMutationReceipt {
  id: string;
  challengeId: string;
  status: 'success' | 'error';
  message: string;
  errorCode?: string;
  errorStatus?: 400 | 403 | 409 | 422 | 429;
  checkoutVersion?: number;
}
export const customerContactMutations = mysqlTable('pos_rewrite_customer_contact_mutations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  challengeId: varchar('challenge_id', { length: 36 }).notNull(),
  operatorId: varchar('operator_id', { length: 32 }).notNull(),
  checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
  action: varchar('action', { length: 24 }).notNull(),
  inputHash: varchar('input_hash', { length: 64 }).notNull(),
  result: json('result').$type<ContactMutationReceipt>().notNull(),
  createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
});
