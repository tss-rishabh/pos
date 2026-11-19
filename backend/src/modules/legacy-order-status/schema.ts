import { bigint, datetime, longtext, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
/**
 * Production `vinculum_auto_delivered_logs`, written by backend-sync-api and read for the
 * order detail "Vinculum Status" tab (`order/views.py:451-464`). Never expose raw payloads.
 */
export const wholeOrderStatusLogs = mysqlTable('vinculum_auto_delivered_logs', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  hasProductId: bigint('has_product_id', { mode: 'bigint' }),
  platform: varchar('platform', { length: 255 }),
  status: mysqlEnum('status', [
    'SUCCESS',
    'FAILED',
    'QUOTA_EXCEEDED',
    'UNEXPECTED',
    'RETRYING',
    'QUEUED',
  ]).notNull(),
  request: longtext('request'),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
});
