import {
  bigint,
  int,
  json,
  mysqlTable,
  varchar,
  index,
  uniqueIndex,
  datetime,
  text,
  tinyint,
} from 'drizzle-orm/mysql-core';
import type { StatusPlatform } from './domain.js';
export const statusReceivers = mysqlTable('pos_rewrite_whole_order_status_receivers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  acceptedAt: bigint('accepted_at_ms', { mode: 'number', unsigned: true }).notNull(),
});
export const statusAttempts = mysqlTable(
  'pos_rewrite_whole_order_status_attempts',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    platform: varchar('platform', { length: 16 }).$type<StatusPlatform>().notNull(),
    state: varchar('state', { length: 16 })
      .$type<'QUEUED' | 'SENDING' | 'SUCCESS' | 'FAILED' | 'UNEXPECTED' | 'UNKNOWN'>()
      .notNull(),
    attempts: int('attempts', { unsigned: true }).notNull().default(0),
    dueAt: bigint('due_at_ms', { mode: 'number', unsigned: true }).notNull(),
    claimedAt: bigint('claimed_at_ms', { mode: 'number', unsigned: true }),
    updatedAt: bigint('updated_at_ms', { mode: 'number', unsigned: true }).notNull(),
    response: json('response').$type<{ responseCode: number; responseMessage: string }>(),
  },
  (table) => [
    index('ix_whole_status_attempt_dispatch').on(table.state, table.dueAt),
    index('ix_whole_status_attempt_operation').on(table.operationId),
  ],
);
export const statusVendorCalls = mysqlTable(
  'pos_rewrite_whole_order_status_vendor_calls',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    stageId: varchar('stage_id', { length: 64 }).notNull(),
    attempt: int('attempt', { unsigned: true }).notNull(),
    bodyHash: varchar('body_hash', { length: 64 }),
    state: varchar('state', { length: 16 })
      .$type<'SENDING' | 'SUCCESS' | 'REJECTED' | 'UNKNOWN'>()
      .notNull(),
    responseCode: int('response_code'),
    createdAt: bigint('created_at_ms', { mode: 'number', unsigned: true }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number', unsigned: true }).notNull(),
  },
  (table) => [uniqueIndex('uq_whole_status_vendor_attempt').on(table.stageId, table.attempt)],
);
export const statusNotificationAttempts = mysqlTable(
  'pos_rewrite_whole_order_status_notifications',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    claimToken: varchar('claim_token', { length: 36 }).notNull(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    kind: varchar('kind', { length: 16 }).$type<'activity' | 'contact'>().notNull(),
    state: varchar('state', { length: 16 }).$type<'SENDING' | 'SUCCESS' | 'UNKNOWN'>().notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number', unsigned: true }).notNull(),
  },
);
export const statusRates = mysqlTable('pos_rewrite_whole_order_status_rates', {
  platform: varchar('platform', { length: 16 }).$type<StatusPlatform>().primaryKey(),
  nextAt: bigint('next_at_ms', { mode: 'number', unsigned: true }).notNull(),
});
/** Verified physical columns absent from the original managed model. */
export const statusNetcoreLines = mysqlTable('has_products', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  genderType: tinyint('gender_type').notNull(),
});
export const statusSourceLogWrites = mysqlTable('vinculum_auto_delivered_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  productId: bigint('product_id', { mode: 'bigint' }).notNull(),
  hasProductId: bigint('has_product_id', { mode: 'bigint' }),
  platform: varchar('platform', { length: 255 }),
  retries: int('retries').notNull(),
  request: text('request'),
  response: text('response'),
  status: varchar('status', { length: 255 }).notNull(),
  message: varchar('message', { length: 255 }),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
});
