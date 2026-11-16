import { datetime, index, int, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

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
export const operatorMfaMutations = mysqlTable('pos_rewrite_operator_mfa_mutations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  actorId: varchar('actor_id', { length: 32 }).notNull(),
  operatorId: varchar('operator_id', { length: 32 }).notNull(),
  hash: varchar('hash', { length: 64 }).notNull(),
  result: json('result').$type<{ status: 'success'; message: string }>().notNull(),
  requestId: varchar('request_id', { length: 128 }),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
});
