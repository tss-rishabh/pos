import { boolean, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const loginChallenges = mysqlTable('pos_rewrite_login_challenges', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 32 }).notNull(),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  authVersion: varchar('auth_version', { length: 64 }).notNull(),
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
  completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
  sentCount: int('sent_count').default(0).notNull(),
});
export const loginSecurity = mysqlTable('pos_rewrite_login_security', {
  userId: varchar('user_id', { length: 32 }).primaryKey(),
  otpHash: varchar('otp_hash', { length: 64 }),
  otpExpiresAt: datetime('otp_expires_at', { mode: 'date', fsp: 3 }),
  lastAttemptAt: datetime('last_attempt_at', { mode: 'date', fsp: 3 }),
  failedCount: int('failed_count').default(0).notNull(),
  failureWindowUntil: datetime('failure_window_until', { mode: 'date', fsp: 3 }),
  lockedUntil: datetime('locked_until', { mode: 'date', fsp: 3 }),
  lastSentAt: datetime('last_sent_at', { mode: 'date', fsp: 3 }),
  alertPending: boolean('alert_pending').default(false).notNull(),
});
