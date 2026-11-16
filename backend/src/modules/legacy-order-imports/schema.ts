import {
  bigint,
  datetime,
  index,
  int,
  mediumtext,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
export type ImportJobState =
  'STAGING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'BLOCKED';
export type ImportOrderState =
  'PENDING' | 'STARTING' | 'RECONCILING' | 'IMPORTED' | 'FAILED' | 'CANCELLED';
export const legacyOrderImports = mysqlTable(
  'pos_rewrite_legacy_order_imports',
  {
    sequence: bigint('sequence', { mode: 'bigint', unsigned: true }).autoincrement().primaryKey(),
    id: varchar('id', { length: 36 }).notNull(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    kind: varchar('kind', { length: 16 }).$type<'offline' | 'shopify'>().notNull(),
    state: varchar('state', { length: 16 }).$type<ImportJobState>().notNull(),
    totalOrders: int('total_orders').notNull(),
    importedOrders: int('imported_orders').notNull(),
    failedOrders: int('failed_orders').notNull(),
    cancelledOrders: int('cancelled_orders').notNull(),
    errorCode: varchar('error_code', { length: 64 }),
    claimToken: varchar('claim_token', { length: 36 }),
    leaseUntil: datetime('lease_until', { mode: 'string', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
    completedAt: datetime('completed_at', { mode: 'string', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_legacy_order_import_id').on(table.id),
    index('ix_legacy_order_import_queue').on(table.state, table.leaseUntil, table.sequence),
    index('ix_legacy_order_import_owner').on(table.actorId, table.sequence),
  ],
);
export const legacyOrderImportRows = mysqlTable(
  'pos_rewrite_legacy_order_import_rows',
  {
    jobId: varchar('job_id', { length: 36 }).notNull(),
    sequence: int('sequence').notNull(),
    firstRow: int('first_row').notNull(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    state: varchar('state', { length: 16 }).$type<ImportOrderState>().notNull(),
    payload: mediumtext('payload').notNull(),
    orderId: varchar('order_id', { length: 32 }),
    receiptId: varchar('receipt_id', { length: 36 }),
    businessDate: varchar('business_date', { length: 10 }),
    proofHash: varchar('proof_hash', { length: 64 }),
    errorCode: varchar('error_code', { length: 64 }),
    updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.sequence] }),
    uniqueIndex('uq_legacy_order_import_operation').on(table.operationId),
    uniqueIndex('uq_legacy_order_import_order').on(table.orderId),
    uniqueIndex('uq_legacy_order_import_receipt').on(table.receiptId),
    index('ix_legacy_order_import_pending').on(table.jobId, table.state, table.sequence),
  ],
);
export type LegacyImportJob = typeof legacyOrderImports.$inferSelect;
export type LegacyImportRow = typeof legacyOrderImportRows.$inferSelect;
