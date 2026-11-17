import { bigint, index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { NodeScreeningWriterCapability } from './capability.js';

/** Opaque admission intent only. Never persist the capability header or JWT. */
export const publicScreeningWork = mysqlTable(
  'pos_rewrite_public_screening_work',
  {
    operationId: varchar('operation_id', { length: 36 }).primaryKey(),
    checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    data: json('data').$type<NodeScreeningWriterCapability>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 24 }).notNull(),
    nextCheckAt: bigint('next_check_at_ms', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('ix_public_screening_work_due').on(table.status, table.nextCheckAt, table.operationId),
  ],
);

export const publicScreeningPaymentEvidence = mysqlTable(
  'pos_rewrite_public_screening_payment_evidence',
  {
    id: varchar('id', { length: 80 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    intent: json('intent').$type<unknown>().notNull(),
    intentHash: varchar('intent_hash', { length: 64 }).notNull(),
    paid: json('paid').$type<unknown>(),
    paidHash: varchar('paid_hash', { length: 64 }),
  },
  (table) => [index('ix_public_screening_payment_order').on(table.orderId, table.id)],
);

/** A durable original dispatch checkpoint survives every local status update. */
export const publicScreeningPublicationDispatches = mysqlTable(
  'pos_rewrite_public_screening_publication_dispatches',
  {
    operationId: varchar('operation_id', { length: 36 }).primaryKey(),
    data: json('data').$type<unknown>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  },
);
export const publicScreeningSubmissionDispatches = mysqlTable(
  'pos_rewrite_public_screening_submission_dispatches',
  {
    operationId: varchar('operation_id', { length: 36 }).primaryKey(),
    data: json('data').$type<unknown>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  },
);
/** Authenticated source acknowledgments survive configuration changes and a
 * lost HTTP reply. They never authorize a second publication dispatch. */
export const publicScreeningPublicationReplies = mysqlTable(
  'pos_rewrite_public_screening_publication_replies',
  {
    operationId: varchar('operation_id', { length: 36 }).primaryKey(),
    data: json('data').$type<unknown>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  },
);
