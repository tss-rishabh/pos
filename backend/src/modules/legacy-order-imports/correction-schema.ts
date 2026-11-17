import { bigint, json, mysqlTable, uniqueIndex, varchar, index } from 'drizzle-orm/mysql-core';
import type { ImportCorrectionBinding, ImportCorrectionReceipt } from './correction-contracts.js';
export const importCorrections = mysqlTable(
  'pos_rewrite_import_corrections',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    originalJobId: varchar('original_job_id', { length: 36 }).notNull(),
    originalOperationId: varchar('original_operation_id', { length: 36 }).notNull(),
    successorJobId: varchar('successor_job_id', { length: 36 }).notNull(),
    successorOperationId: varchar('successor_operation_id', { length: 36 }).notNull(),
    managerId: varchar('manager_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    planHash: varchar('plan_hash', { length: 64 }).notNull(),
    body: json('body').$type<ImportCorrectionBinding>().notNull(),
    receipt: json('receipt').$type<ImportCorrectionReceipt>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 128 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_import_correction_original').on(table.originalOperationId),
    uniqueIndex('uq_import_correction_successor').on(table.successorOperationId),
    uniqueIndex('uq_import_correction_job').on(table.successorJobId),
    index('ix_import_correction_job').on(table.originalJobId, table.id),
  ],
);
