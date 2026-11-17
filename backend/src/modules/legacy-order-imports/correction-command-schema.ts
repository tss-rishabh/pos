import { bigint, index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { ImportCorrectionCommandOutcome } from './correction-contracts.js';
export const importCorrectionCommands = mysqlTable(
  'pos_rewrite_import_correction_commands',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    originalJobId: varchar('original_job_id', { length: 36 }).notNull(),
    originalOperationId: varchar('original_operation_id', { length: 36 }).notNull(),
    managerId: varchar('manager_id', { length: 32 }).notNull(),
    uploadHash: varchar('upload_hash', { length: 64 }).notNull(),
    planHash: varchar('plan_hash', { length: 64 }).notNull(),
    groupHash: varchar('group_hash', { length: 64 }).notNull(),
    reservationToken: varchar('reservation_token', { length: 36 }).notNull(),
    state: varchar('state', { length: 16 }).$type<'RESERVED' | 'ACCEPTED' | 'FENCED'>().notNull(),
    outcome: json('outcome').$type<ImportCorrectionCommandOutcome>(),
    proofHash: varchar('proof_hash', { length: 64 }),
    requestId: varchar('request_id', { length: 128 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('ix_import_correction_command_scope').on(
      table.originalJobId,
      table.originalOperationId,
      table.createdAt,
      table.id,
    ),
  ],
);
