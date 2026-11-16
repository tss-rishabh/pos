import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  datetime,
  index,
  int,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

const milliseconds = (name: string) => bigint(name, { mode: 'bigint', unsigned: true });
/** Read/write mapping verified in mysql-extra-schema.json. The owned migration never creates this legacy table. */
export const sourceApplicationScans = mysqlTable('pos_to_app_logs', {
  id: int('id').primaryKey().autoincrement(),
  storeId: int('store_id').notNull().default(0),
  scannedAt: datetime('scanned_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  createdAt: datetime('created_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
export const staffDownloadGrants = mysqlTable(
  'pos_rewrite_staff_download_grants',
  {
    id: char('id', { length: 36 }).primaryKey(),
    operationId: char('operation_id', { length: 36 }).notNull(),
    operatorId: bigint('operator_id', { mode: 'bigint' }).notNull(),
    qrDigest: char('qr_digest', { length: 64 }).notNull(),
    authVersion: char('auth_version', { length: 64 }).notNull(),
    artifactVersion: char('artifact_version', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    state: varchar('state', { length: 16 })
      .$type<'ISSUED' | 'ACTIVATED' | 'CONSUMED' | 'REVOKED'>()
      .notNull(),
    expiresAt: milliseconds('expires_at').notNull(),
    activationOperationId: char('activation_operation_id', { length: 36 }),
    activationDigest: char('activation_digest', { length: 64 }),
    activationExpiresAt: milliseconds('activation_expires_at'),
    downloadOperationId: char('download_operation_id', { length: 36 }),
    createdAt: milliseconds('created_at').notNull(),
    updatedAt: milliseconds('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_staff_download_operation').on(table.operationId),
    uniqueIndex('uq_staff_download_qr').on(table.qrDigest),
    uniqueIndex('uq_staff_download_activation').on(table.activationDigest),
    index('ix_staff_download_operator_state').on(table.operatorId, table.state, table.expiresAt),
    index('ix_staff_download_expiry').on(table.expiresAt),
  ],
);
export const customerApplicationLinks = mysqlTable(
  'pos_rewrite_customer_application_links',
  {
    id: char('id', { length: 36 }).primaryKey(),
    storeId: bigint('store_id', { mode: 'bigint' }).notNull(),
    tokenDigest: char('token_digest', { length: 64 }).notNull(),
    createdBy: bigint('created_by', { mode: 'bigint' }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: milliseconds('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_customer_application_store').on(table.storeId),
    uniqueIndex('uq_customer_application_token').on(table.tokenDigest),
  ],
);
export const customerApplicationCache = mysqlTable('pos_rewrite_customer_application_cache', {
  storeId: bigint('store_id', { mode: 'bigint' }).primaryKey(),
  providerOperationId: char('provider_operation_id', { length: 36 }).notNull(),
  configurationVersion: char('configuration_version', { length: 64 }).notNull(),
  target: varchar('target', { length: 2048 }),
  expiresAt: milliseconds('expires_at').notNull(),
  leaseId: char('lease_id', { length: 36 }),
  leaseUntil: milliseconds('lease_until'),
});
export const applicationScanReceipts = mysqlTable(
  'pos_rewrite_application_scan_receipts',
  {
    id: char('id', { length: 36 }).primaryKey(),
    linkId: char('link_id', { length: 36 }).notNull(),
    storeId: bigint('store_id', { mode: 'bigint' }).notNull(),
    target: varchar('target', { length: 2048 }),
    sourceLogId: int('source_log_id'),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: milliseconds('created_at').notNull(),
  },
  (table) => [index('ix_application_scan_receipt_created').on(table.createdAt)],
);
