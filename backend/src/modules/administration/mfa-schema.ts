import { datetime, index, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/**
 * @deprecated Enrollments moved to `pos_user.mfa_hash` + Redis `pos:mfa_enroll:{operatorId}`
 * (`mfa.ts`). Nothing in this module reads or writes the table; the export remains only because
 * `src/auth/revocation.ts` (W3) still updates it. Remove with that caller.
 */
export const operatorMfaEnrollments = mysqlTable(
  'pos_rewrite_operator_mfa_enrollments',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    actorVersion: varchar('actor_version', { length: 64 }).notNull(),
    operatorVersion: varchar('operator_version', { length: 64 }).notNull(),
    sealedSecret: varchar('sealed_secret', { length: 1024 }).notNull(),
    state: varchar('state', { length: 16 }).$type<'PENDING' | 'VERIFIED' | 'CANCELLED'>().notNull(),
    attempts: int('attempts').notNull(),
    lastAttemptAt: datetime('last_attempt_at', { mode: 'string', fsp: 3 }),
    expiresAt: datetime('expires_at', { mode: 'string', fsp: 3 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (table) => [
    index('ix_rewrite_operator_mfa_actor').on(table.actorId, table.state),
    index('ix_rewrite_operator_mfa_pending').on(table.operatorId, table.state, table.expiresAt),
    index('ix_rewrite_operator_mfa_expiry').on(table.expiresAt),
  ],
);
