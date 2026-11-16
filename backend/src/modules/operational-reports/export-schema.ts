import {
  boolean,
  datetime,
  index,
  int,
  json,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { ReportExportInput, ExportStatus } from './export-domain.js';

/** Separate from legacy report_exports: old clients cannot expose these private files. */
export const reportExportJobs = mysqlTable(
  'pos_rewrite_report_exports',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    commandId: varchar('command_id', { length: 36 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    input: json('input').$type<ReportExportInput>().notNull(),
    storeIds: json('store_ids').$type<string[]>().notNull(),
    requiresGlobal: boolean('requires_global').notNull(),
    requesterUserType: int('requester_user_type').notNull(),
    status: varchar('status', { length: 16 }).$type<ExportStatus>().notNull(),
    claimToken: varchar('claim_token', { length: 36 }),
    leaseUntil: datetime('lease_until', { mode: 'string', fsp: 3 }),
    recoveryAttempts: int('recovery_attempts').notNull().default(0),
    artifactKey: varchar('artifact_key', { length: 1024 }),
    checksum: varchar('checksum', { length: 64 }),
    byteCount: int('byte_count'),
    rowCount: int('row_count'),
    errorCode: varchar('error_code', { length: 64 }),
    requestedAt: datetime('requested_at', { mode: 'string', fsp: 3 }).notNull(),
    completedAt: datetime('completed_at', { mode: 'string', fsp: 3 }),
    updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_report_export_command').on(table.operatorId, table.commandId),
    index('ix_report_export_queue').on(table.status, table.leaseUntil, table.requestedAt),
    index('ix_report_export_owner').on(table.operatorId, table.requestedAt),
  ],
);
export type ReportExportJob = typeof reportExportJobs.$inferSelect;
