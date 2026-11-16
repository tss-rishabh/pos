import { datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const securityAlerts = mysqlTable('pos_rewrite_login_security_alerts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 32 }).notNull(),
  requestId: varchar('request_id', { length: 36 }),
  factor: varchar('factor', { length: 8 }).notNull(),
  failedAttempts: int('failed_attempts').notNull(),
  lockedUntil: datetime('locked_until', { mode: 'date', fsp: 3 }).notNull(),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  state: varchar('state', { length: 16 }).notNull(),
  attempts: int('attempts').notNull(),
  availableAt: datetime('available_at', { mode: 'date', fsp: 3 }).notNull(),
  leaseToken: varchar('lease_token', { length: 36 }),
  leaseUntil: datetime('lease_until', { mode: 'date', fsp: 3 }),
  deliveredAt: datetime('delivered_at', { mode: 'date', fsp: 3 }),
});
