import { bigint, index, int, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';

export const customerRegistrationsTable = mysqlTable(
  'pos_rewrite_customer_registrations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    phoneHash: varchar('phone_hash', { length: 64 }).notNull(),
    emailHash: varchar('email_hash', { length: 64 }).notNull(),
    encryptedInput: text('encrypted_input').notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    attempts: int('verification_attempts').notNull(),
    expiresAt: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    verifiedAt: bigint('verified_at_ms', { mode: 'number' }),
    customerId: varchar('customer_id', { length: 32 }),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [index('ix_customer_registration_checkout').on(table.checkoutId, table.createdAt)],
);

export const customerRegistrationClaims = mysqlTable('pos_rewrite_customer_registration_claims', {
  key: varchar('claim_key', { length: 70 }).primaryKey(),
  registrationId: varchar('registration_id', { length: 36 }).notNull(),
});
export const customerRegistrationLimits = mysqlTable('pos_rewrite_customer_registration_limits', {
  key: varchar('limit_key', { length: 96 }).primaryKey(),
  lastSentAt: bigint('last_sent_at_ms', { mode: 'number' }).notNull(),
  sendWindowAt: bigint('send_window_at_ms', { mode: 'number' }).notNull(),
  sends: int('send_count').notNull(),
  failureWindowAt: bigint('failure_window_at_ms', { mode: 'number' }).notNull(),
  failures: int('verification_failures').notNull(),
});
export const customerRegistrationDeliveries = mysqlTable(
  'pos_rewrite_customer_registration_deliveries',
  {
    id: varchar('id', { length: 48 }).primaryKey(),
    registrationId: varchar('registration_id', { length: 36 }).notNull(),
    channel: varchar('channel', { length: 12 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    availableAt: bigint('available_at_ms', { mode: 'number' }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('ix_customer_registration_delivery_poll').on(table.status, table.availableAt, table.id),
    index('ix_customer_registration_delivery').on(table.registrationId, table.createdAt, table.id),
  ],
);
