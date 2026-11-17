import {
  bigint,
  int,
  datetime,
  index,
  json,
  mysqlTable,
  text,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { StatusSnapshot, StatusReceipt, StatusPlatform, StatusState } from './domain.js';
export const wholeOrderStatusCommands = mysqlTable(
  'pos_rewrite_whole_order_status_commands',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    effectKey: varchar('effect_key', { length: 64 }).notNull().unique(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    authVersion: varchar('auth_version', { length: 64 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    platform: varchar('platform', { length: 16 }).$type<StatusPlatform>().notNull(),
    source: varchar('source', { length: 32 }).$type<'manual' | 'return-failure'>().notNull(),
    returnOperationId: varchar('return_operation_id', { length: 36 }),
    requestId: varchar('request_id', { length: 128 }),
    snapshot: json('snapshot').$type<StatusSnapshot>().notNull(),
    scopeHash: varchar('scope_hash', { length: 64 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    state: varchar('state', { length: 16 }).$type<StatusState>().notNull(),
    attempts: int('attempts', { unsigned: true }).notNull(),
    receipt: json('receipt').$type<StatusReceipt>(),
    errorCode: varchar('error_code', { length: 64 }),
    claimedAt: datetime('claimed_at', { mode: 'string', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (table) => [
    index('ix_whole_order_status_dispatch').on(table.state, table.createdAt),
    index('ix_whole_order_status_active').on(table.orderId, table.state),
    index('ix_whole_order_status_order').on(table.storeId, table.orderId, table.createdAt),
  ],
);
/** Verified physical extra column; generated source model omits has_product_id. Never expose raw payloads. */
export const wholeOrderStatusLogs = mysqlTable('vinculum_auto_delivered_logs', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  hasProductId: bigint('has_product_id', { mode: 'bigint' }),
  platform: varchar('platform', { length: 255 }),
  status: varchar('status', { length: 255 }),
  request: text('request'),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
});
