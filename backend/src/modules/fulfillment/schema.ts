import {
  bigint,
  datetime,
  int,
  json,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { NoticeEvent } from './notification-bus.js';

/**
 * COMPATIBILITY ONLY. The fulfillment module no longer reads or writes these rewrite tables
 * (schema freeze). The definitions stay exported solely because modules outside W5's
 * fulfillment ownership still import them: `finance/alerts.ts` (`fulfillmentEffects`, owner W8)
 * and `legacy-fulfillment/lifecycle/notice.ts` (`notificationEvents`). Delete this file once
 * those callers move to `fulfillmentEffects().slack` / `createOrderNotification`.
 */
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
  payload: json('payload').$type<Record<string, string | number | boolean | string[]>>().notNull(),
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
