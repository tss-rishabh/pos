import { datetime, index, json, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import type { CancellationReceipt } from './contracts.js';
export const pendingOrderCancellations = mysqlTable(
  'pos_rewrite_pending_order_cancellations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    receiptHash: varchar('receipt_hash', { length: 64 }).notNull(),
    receipt: json('receipt').$type<CancellationReceipt>().notNull(),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_pending_cancel_order').on(table.orderId),
    index('ix_pending_cancel_store').on(table.storeId, table.createdAt, table.id),
  ],
);
