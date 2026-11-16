import { bigint, index, int, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';

export const desktopSsoFlows = mysqlTable(
  'pos_rewrite_desktop_sso_flows',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    status: varchar('status', { length: 24 }).notNull(),
    desktopSecretHash: varchar('desktop_secret_hash', { length: 64 }).notNull(),
    browserTicketHash: varchar('browser_ticket_hash', { length: 64 }).notNull(),
    pairingCodeHash: varchar('pairing_code_hash', { length: 64 }).notNull(),
    approvalSecretHash: varchar('approval_secret_hash', { length: 64 }),
    operatorId: varchar('operator_id', { length: 32 }),
    authVersion: varchar('auth_version', { length: 128 }),
    approvalAttempts: int('approval_attempts').notNull().default(0),
    consumedCredential: text('consumed_credential'),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    startedAt: bigint('started_at_ms', { mode: 'number' }),
    approvedAt: bigint('approved_at_ms', { mode: 'number' }),
    consumedAt: bigint('consumed_at_ms', { mode: 'number' }),
    requestId: varchar('request_id', { length: 128 }),
  },
  (table) => [index('ix_desktop_sso_expiry').on(table.expiresAt, table.id)],
);
