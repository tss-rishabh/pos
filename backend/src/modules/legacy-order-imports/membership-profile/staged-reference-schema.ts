import { bigint, index, json, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import type { CsvMembershipStagedReference } from './staged-reference-contracts.js';
export const csvMembershipStagedReferences = mysqlTable(
  'pos_rewrite_import_membership_staged_references',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    grantId: varchar('grant_id', { length: 36 }).notNull(),
    data: json('data').$type<CsvMembershipStagedReference>().notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_import_member_staged_reference_grant').on(table.operationId, table.grantId),
    index('ix_import_member_staged_reference_order').on(table.orderId, table.createdAt, table.id),
  ],
);
