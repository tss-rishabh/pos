import { bigint, char, index, int, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
const ms = (name: string) => bigint(name, { mode: 'bigint', unsigned: true });
export const customerWebsiteHandoffs = mysqlTable(
  'pos_rewrite_customer_website_handoffs',
  {
    id: char('id', { length: 36 }).primaryKey(),
    operationId: char('operation_id', { length: 36 }).notNull(),
    checkoutId: char('checkout_id', { length: 36 }).notNull(),
    checkoutVersion: int('checkout_version').notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    operatorCustomerId: varchar('operator_customer_id', { length: 32 }).notNull(),
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    operatorSessionId: char('operator_session_id', { length: 36 }).notNull(),
    challengeId: char('challenge_id', { length: 36 }).notNull(),
    verifiedUntil: ms('verified_until_ms').notNull(),
    authorityHash: char('authority_hash', { length: 64 }).notNull(),
    configurationHash: char('configuration_hash', { length: 64 }).notNull(),
    tokenDigest: char('token_digest', { length: 64 }).notNull(),
    state: varchar('state', { length: 16 }).$type<'ISSUED' | 'CONSUMED' | 'REVOKED'>().notNull(),
    expiresAt: ms('expires_at_ms').notNull(),
    sessionExpiresAt: ms('session_expires_at_ms').notNull(),
    createdAt: ms('created_at_ms').notNull(),
    updatedAt: ms('updated_at_ms').notNull(),
    consumedOperationId: char('consumed_operation_id', { length: 36 }),
    browserBindingDigest: char('browser_binding_digest', { length: 64 }),
    consumedAt: ms('consumed_at_ms'),
    requestId: varchar('request_id', { length: 128 }),
    consumedRequestId: varchar('consumed_request_id', { length: 128 }),
  },
  (table) => [
    uniqueIndex('uq_customer_website_handoff_operation').on(table.operationId),
    uniqueIndex('uq_customer_website_handoff_token').on(table.tokenDigest),
    uniqueIndex('uq_customer_website_handoff_consumption').on(table.consumedOperationId),
    index('ix_customer_website_handoff_checkout').on(
      table.checkoutId,
      table.state,
      table.expiresAt,
    ),
    index('ix_customer_website_handoff_expiry').on(table.expiresAt),
  ],
);
export type CustomerWebsiteGrant = typeof customerWebsiteHandoffs.$inferSelect;
