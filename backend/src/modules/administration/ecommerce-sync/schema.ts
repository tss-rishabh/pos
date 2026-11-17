import {
  bigint,
  datetime,
  int,
  json,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { FullSyncResult } from './domain.js';
export const ecommerceSyncCommands = mysqlTable('pos_rewrite_ecommerce_inventory_syncs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  storeId: bigint('store_id', { mode: 'bigint' }).notNull(),
  actorId: varchar('actor_id', { length: 32 }).notNull(),
  requestId: varchar('request_id', { length: 128 }),
  policyHash: varchar('policy_hash', { length: 64 }).notNull(),
  threshold: int('threshold').notNull(),
  active: int('active').notNull(),
  state: varchar('state', { length: 16 })
    .$type<'PREPARING' | 'PROJECTING' | 'FULL_SYNC' | 'COMPLETED' | 'BLOCKED'>()
    .notNull(),
  fullState: varchar('full_state', { length: 16 })
    .$type<'READY' | 'POSTING' | 'UNCERTAIN' | 'PENDING' | 'SUCCEEDED'>()
    .notNull(),
  selectedRows: int('selected_rows').notNull(),
  processedRows: int('processed_rows').notNull(),
  skippedRows: int('skipped_rows').notNull(),
  errorCode: varchar('error_code', { length: 64 }),
  fullResult: json('full_result').$type<FullSyncResult | null>(),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
});
export const ecommerceSyncRows = mysqlTable(
  'pos_rewrite_ecommerce_inventory_sync_rows',
  {
    syncId: varchar('sync_id', { length: 36 }).notNull(),
    associationId: bigint('association_id', { mode: 'bigint' }).notNull(),
    productId: bigint('product_id', { mode: 'bigint' }).notNull(),
    selectedStock: int('selected_stock').notNull(),
    currentStock: int('current_stock'),
    state: varchar('state', { length: 16 }).$type<'PENDING' | 'PROCESSED' | 'SKIPPED'>().notNull(),
    updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (row) => [primaryKey({ columns: [row.syncId, row.associationId] })],
);
