import {
  bigint,
  char,
  datetime,
  int,
  json,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { PerformanceReceipt } from './contracts.js';

export const checkoutPerformanceReceipts = mysqlTable(
  'pos_rewrite_checkout_performance',
  {
    operationId: varchar('operation_id', { length: 36 }).primaryKey(),
    checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
    checkoutOperationId: varchar('checkout_operation_id', { length: 36 }).notNull(),
    checkoutVersion: int('checkout_version').notNull(),
    orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
    orderStoreId: bigint('order_store_id', { mode: 'bigint' }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    customerId: bigint('customer_id', { mode: 'bigint' }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    headerHash: char('header_hash', { length: 64 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    paymentId: varchar('payment_id', { length: 36 }),
    performanceJson: varchar('performance_json', { length: 255 }).notNull(),
    receipt: json('receipt').$type<PerformanceReceipt>().notNull(),
    requestId: varchar('request_id', { length: 128 }),
    recordedAt: datetime('recorded_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [uniqueIndex('ux_checkout_performance_order').on(table.orderId)],
);
