import { datetime, index, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const operatorSessions = mysqlTable(
  'pos_rewrite_sessions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 32 }).notNull(),
    secretHash: varchar('secret_hash', { length: 64 }).notNull(),
    authVersion: varchar('auth_version', { length: 64 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    index('ix_rewrite_session_user').on(table.userId),
    index('ix_rewrite_session_expiry').on(table.expiresAt),
  ],
);
