import { bigint, datetime, int, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/**
 * COMPATIBILITY ONLY. The fulfillment module no longer reads or writes this rewrite table
 * (schema freeze), and no worker drains it any more. The definition stays exported solely because
 * `finance/alerts.ts` (owner W8) still inserts its day-close Slack alert here; legacy sends that
 * alert synchronously (`report/views.py:2573`). Delete this file once finance posts the alert
 * inline (for example with `fulfillmentEffects(...).slack`).
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
