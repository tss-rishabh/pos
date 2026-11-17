import { bigint, index, json, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import type { CsvMembershipReference } from './reference-contracts.js';

/** Appended only with an explicit, authenticated manager succession grant. */
export const csvMembershipReferences = mysqlTable(
  'pos_rewrite_import_membership_references',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    grantId: varchar('grant_id', { length: 36 }).notNull(),
    data: json('data').$type<CsvMembershipReference>().notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_import_membership_reference_grant').on(table.operationId, table.grantId),
    index('ix_import_membership_reference_order').on(table.orderId, table.createdAt, table.id),
  ],
);
