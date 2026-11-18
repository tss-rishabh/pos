import { bigint, int, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';

/**
 * DEPRECATED. Customer registration no longer reads or writes these rewrite tables: its state is
 * in Redis (`service.ts`, `registrationKeys`). These two definitions remain only because
 * `customer-contacts/authority.ts` still imports them; it should switch to
 * `readRegistrationOutcome` / `readRegistrationClaim` from `./service.js`, after which this file
 * is deleted. `pos_rewrite_customer_registration_limits` and `_deliveries` are freed.
 */
export const customerRegistrationsTable = mysqlTable('pos_rewrite_customer_registrations', {
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
});
export const customerRegistrationClaims = mysqlTable('pos_rewrite_customer_registration_claims', {
  key: varchar('claim_key', { length: 70 }).primaryKey(),
  registrationId: varchar('registration_id', { length: 36 }).notNull(),
});
