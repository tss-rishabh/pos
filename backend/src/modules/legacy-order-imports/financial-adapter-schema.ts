import {
  bigint,
  int,
  index,
  json,
  mediumtext,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type {
  FinancialImportApprovalView,
  FinancialImportAuthority,
  ImportCompletedProof,
  ImportFinancialState,
} from './financial-adapter-contracts.js';
import type { FinancialPreparationAttempt } from './financial-adapter-preparation-contracts.js';

export const financialImportPreparations = mysqlTable(
  'pos_rewrite_import_financial_preparations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    sequence: int('sequence_no', { unsigned: true }).notNull(),
    data: json('data').$type<FinancialPreparationAttempt>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    artifact: mediumtext('artifact'),
  },
  (table) => [uniqueIndex('uq_import_preparation_sequence').on(table.operationId, table.sequence)],
);
export const financialImportOperations = mysqlTable(
  'pos_rewrite_import_financial_operations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    planHash: varchar('plan_hash', { length: 64 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    namespace: varchar('namespace', { length: 64 }).notNull(),
    payload: mediumtext('payload').notNull(),
    state: json('state').$type<ImportFinancialState>().notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_import_financial_namespace').on(table.namespace),
    index('ix_import_financial_scope').on(table.actorId, table.storeId, table.createdAt, table.id),
  ],
);
export const financialImportApprovals = mysqlTable(
  'pos_rewrite_import_financial_approvals',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    commandId: varchar('command_id', { length: 36 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    planHash: varchar('plan_hash', { length: 64 }).notNull(),
    data: json('data').$type<FinancialImportApprovalView>().notNull(),
    authority: json('authority').$type<FinancialImportAuthority>().notNull(),
    approverVersion: varchar('approver_version', { length: 64 }).notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_import_financial_approval_command').on(table.commandId),
    index('ix_import_financial_approval_operation').on(
      table.operationId,
      table.createdAt,
      table.id,
    ),
  ],
);
export const financialImportStages = mysqlTable(
  'pos_rewrite_import_financial_stages',
  {
    id: varchar('id', { length: 80 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    nonce: varchar('nonce', { length: 36 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    proofHash: varchar('proof_hash', { length: 64 }),
    proof: json('proof').$type<unknown>(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [uniqueIndex('uq_import_financial_stage').on(table.operationId, table.kind)],
);
export const financialImportSourceReceipts = mysqlTable(
  'pos_rewrite_import_financial_source_receipts',
  {
    id: varchar('id', { length: 80 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    proof: json('proof').$type<unknown>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [uniqueIndex('uq_import_financial_source').on(table.operationId, table.kind)],
);
export const financialImportProofs = mysqlTable(
  'pos_rewrite_import_financial_proofs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    data: json('data').$type<ImportCompletedProof>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    finalizedAt: bigint('finalized_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_import_financial_proof_operation').on(table.operationId),
    uniqueIndex('uq_import_financial_proof_order').on(table.orderId),
  ],
);
export const financialImportReferences = mysqlTable('pos_rewrite_import_financial_references', {
  id: varchar('id', { length: 64 }).primaryKey(),
  operationId: varchar('operation_id', { length: 36 }).notNull(),
  planHash: varchar('plan_hash', { length: 64 }).notNull(),
});
export const financialImportCloseImpacts = mysqlTable(
  'pos_rewrite_import_financial_close_impacts',
  {
    id: varchar('id', { length: 100 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    closeId: varchar('close_id', { length: 32 }).notNull(),
    closeVersion: varchar('close_version', { length: 16 }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [index('ix_import_financial_close_operation').on(table.operationId)],
);

export const financialImportOrderBindings = mysqlTable(
  'pos_rewrite_import_financial_order_bindings',
  {
    orderId: varchar('order_id', { length: 32 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
  },
  (table) => [uniqueIndex('uq_import_financial_order_operation').on(table.operationId)],
);
/** Private API-v2 stores captured source task arguments encrypted at rest. */
export const financialImportSourceEffects = mysqlTable(
  'pos_rewrite_import_financial_source_effects',
  {
    operationId: varchar('operation_id', { length: 36 }).primaryKey(),
    payload: mediumtext('payload').notNull(),
    effectsHash: varchar('effects_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    deliveries: json('deliveries').$type<unknown>().notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
);
