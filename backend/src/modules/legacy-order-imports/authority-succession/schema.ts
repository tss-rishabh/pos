import { mysqlTable, varchar, int, json, bigint, index, uniqueIndex } from 'drizzle-orm/mysql-core';
import type {
  ImportSuccessionEnvelope,
  ImportSuccessionClaim,
  ImportSuccessionContinuation,
} from './contracts.js';
export const importAuthoritySuccessions = mysqlTable(
  'pos_rewrite_import_authority_successions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    sequence: int('sequence_no', { unsigned: true }).notNull(),
    jobId: varchar('job_id', { length: 36 }).notNull(),
    managerId: varchar('manager_id', { length: 32 }).notNull(),
    managerSessionId: varchar('manager_session_id', { length: 36 }).notNull(),
    commandHash: varchar('command_hash', { length: 64 }).notNull(),
    data: json('data').$type<ImportSuccessionEnvelope>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('uq_import_authority_sequence').on(t.operationId, t.sequence),
    index('ix_import_authority_job').on(t.jobId, t.operationId),
  ],
);
export const importAuthorityHeads = mysqlTable('pos_rewrite_import_authority_heads', {
  operationId: varchar('operation_id', { length: 36 }).primaryKey(),
  grantId: varchar('grant_id', { length: 36 }).notNull(),
  sequence: int('sequence_no', { unsigned: true }).notNull(),
  sourceHash: varchar('source_hash', { length: 64 }).notNull(),
  activeCommandId: varchar('active_command_id', { length: 36 }),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
});
export const importAuthorityStageClaims = mysqlTable(
  'pos_rewrite_import_authority_stage_claims',
  {
    id: varchar('id', { length: 100 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    stage: varchar('stage', { length: 16 }).notNull(),
    grantId: varchar('grant_id', { length: 36 }).notNull(),
    data: json('data').$type<ImportSuccessionClaim>().notNull(),
    sourceHash: varchar('source_hash', { length: 64 }).notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  },
  (t) => [uniqueIndex('uq_import_authority_stage').on(t.operationId, t.stage, t.grantId)],
);
export const importAuthorityContinuations = mysqlTable(
  'pos_rewrite_import_authority_continuations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    grantId: varchar('grant_id', { length: 36 }).notNull(),
    managerId: varchar('manager_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    data: json('data').$type<ImportSuccessionContinuation>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  },
  (t) => [index('ix_import_authority_continuation').on(t.operationId, t.grantId, t.id)],
);
