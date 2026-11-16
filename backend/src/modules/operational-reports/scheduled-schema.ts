import {
  datetime,
  index,
  int,
  json,
  mysqlTable,
  mediumtext,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { ScheduleInput } from './scheduled-domain.js';
export type ScheduledJobStatus =
  'QUEUED' | 'BUILDING' | 'READY' | 'DELIVERED' | 'FAILED' | 'DELIVERY_UNKNOWN';
export type ScheduledTargetStatus = 'PENDING' | 'SENDING' | 'DELIVERED' | 'UNKNOWN';
export const scheduledReportJobs = mysqlTable(
  'pos_rewrite_scheduled_reports',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    commandId: varchar('command_id', { length: 36 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    userId: varchar('user_id', { length: 32 }).notNull(),
    input: json('input').$type<ScheduleInput & { date: string }>().notNull(),
    status: varchar('status', { length: 24 }).$type<ScheduledJobStatus>().notNull(),
    recordCount: int('record_count'),
    errorCode: varchar('error_code', { length: 64 }),
    claimToken: varchar('claim_token', { length: 36 }),
    leaseUntil: datetime('lease_until', { mode: 'string', fsp: 3 }),
    requestedAt: datetime('requested_at', { mode: 'string', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
    completedAt: datetime('completed_at', { mode: 'string', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_scheduled_report_command').on(table.commandId),
    index('ix_scheduled_report_queue').on(table.status, table.leaseUntil, table.requestedAt),
  ],
);
export const scheduledReportTargets = mysqlTable(
  'pos_rewrite_scheduled_report_targets',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    jobId: varchar('job_id', { length: 36 }).notNull(),
    target: varchar('target', { length: 8 }).$type<'main' | 'demo'>().notNull(),
    part: int('part').notNull(),
    body: mediumtext('body').notNull(),
    status: varchar('status', { length: 16 }).$type<ScheduledTargetStatus>().notNull(),
    claimToken: varchar('claim_token', { length: 36 }),
    leaseUntil: datetime('lease_until', { mode: 'string', fsp: 3 }),
    attemptedAt: datetime('attempted_at', { mode: 'string', fsp: 3 }),
    deliveredAt: datetime('delivered_at', { mode: 'string', fsp: 3 }),
    reconciliationCommandId: varchar('reconciliation_command_id', { length: 36 }),
    reconciliationOutcome: varchar('reconciliation_outcome', { length: 16 }).$type<
      'delivered' | 'not-delivered'
    >(),
    updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_scheduled_report_target').on(table.jobId, table.target, table.part),
    index('ix_scheduled_report_target_queue').on(table.status, table.leaseUntil),
    index('ix_scheduled_report_target_job').on(table.jobId),
  ],
);
export type ScheduledReportJob = typeof scheduledReportJobs.$inferSelect;
export type ScheduledReportTarget = typeof scheduledReportTargets.$inferSelect;
export const scheduledReportChannels = mysqlTable('pos_rewrite_scheduled_report_channels', {
  id: varchar('id', { length: 64 }).primaryKey(),
  nextAllowedAt: datetime('next_allowed_at', { mode: 'string', fsp: 3 }).notNull(),
});
