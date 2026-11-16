import {
  bigint,
  datetime,
  int,
  json,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { FulfillmentEffect } from './domain.js';
import type { NoticeEvent } from './notification-bus.js';

export interface ActionReceipt {
  commandId: string;
  action: string;
  storeId: string;
  orderId: string;
  updatedCount: number;
  integrationState: 'not-required' | 'pending';
  effectIds: string[];
}
export const fulfillmentCommands = mysqlTable(
  'pos_rewrite_fulfillment_commands',
  {
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    commandId: varchar('command_id', { length: 36 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    result: json('result').$type<ActionReceipt>(),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.operatorId, table.commandId] })],
);
export const fulfillmentEffects = mysqlTable('pos_rewrite_fulfillment_effects', {
  id: varchar('id', { length: 36 }).primaryKey(),
  dispatchOrder: bigint('dispatch_order', { mode: 'bigint', unsigned: true })
    .notNull()
    .autoincrement()
    .unique(),
  commandId: varchar('command_id', { length: 36 }).notNull(),
  operatorId: varchar('operator_id', { length: 32 }).notNull(),
  requestId: varchar('request_id', { length: 128 }),
  storeId: varchar('store_id', { length: 32 }).notNull(),
  orderId: varchar('order_id', { length: 32 }).notNull(),
  kind: varchar('kind', { length: 40 }).notNull(),
  payload: json('payload').$type<FulfillmentEffect['payload']>().notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  attempts: int('attempts').notNull(),
  sequence: int('sequence').notNull(),
  result: json('result').$type<Record<string, string | number | boolean>>(),
  claimedAt: datetime('claimed_at', { mode: 'string' }),
  completedAt: datetime('completed_at', { mode: 'string' }),
  lastErrorCode: varchar('last_error_code', { length: 64 }),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
export const notificationEvents = mysqlTable(
  'pos_rewrite_notification_events',
  {
    eventId: varchar('event_id', { length: 36 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    notice: json('notice').$type<NoticeEvent>(),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
    publishedAt: datetime('published_at', { mode: 'string' }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.storeId] })],
);
