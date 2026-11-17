import {
  char,
  bigint,
  date,
  datetime,
  decimal,
  index,
  json,
  int,
  mysqlTable,
  uniqueIndex,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { PaymentReversalReceipt } from './contracts.js';

export const paymentReversals = mysqlTable(
  'pos_rewrite_payment_reversals',
  {
    id: char('id', { length: 36 }).primaryKey(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    originalPaymentId: char('original_payment_id', { length: 36 }).notNull(),
    cashReturnReceiptId: char('cash_return_receipt_id', { length: 36 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    receiptHash: char('receipt_hash', { length: 64 }).notNull(),
    receipt: json('receipt').$type<PaymentReversalReceipt>().notNull(),
    requestId: varchar('request_id', { length: 128 }),
    recordedAt: datetime('recorded_at', { mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('payment_reversal_original').on(table.originalPaymentId),
    uniqueIndex('payment_reversal_cash_return').on(table.cashReturnReceiptId),
    index('payment_reversal_order').on(table.orderId, table.recordedAt, table.id),
  ],
);
export const paymentCorrectionOrders = mysqlTable(
  'pos_rewrite_payment_correction_orders',
  {
    orderId: varchar('order_id', { length: 32 }).primaryKey(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    orderDate: date('order_date', { mode: 'string' }).notNull(),
    firstPaymentId: char('first_payment_id', { length: 36 }).notNull(),
    inputHash: char('input_hash', { length: 64 }).notNull(),
  },
  (table) => [
    index('payment_correction_order_day').on(table.storeId, table.orderDate, table.orderId),
  ],
);

/** Verified physical fulfillment flags omitted by the original Django model.
 * Source metadata: evidence/mysql-extra-schema.json has_products. No source DDL. */
export const paymentReversalLineAuthority = mysqlTable('has_products', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  shipped: tinyint('is_order_shipped'),
  outForDelivery: tinyint('is_order_out_for_delivery'),
  delivered: tinyint('is_order_delivered'),
  cancelledReturn: tinyint('is_return_cancel'),
  returnAwb: varchar('return_awb', { length: 50 }),
  returnCourierId: int('return_courier_id'),
});
export const paymentCorrectionCash = mysqlTable(
  'pos_rewrite_payment_correction_cash',
  {
    id: varchar('id', { length: 80 }).primaryKey(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    direction: varchar('direction', { length: 3 }).notNull(),
    amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    sourceId: char('source_id', { length: 36 }).notNull(),
    inputHash: char('input_hash', { length: 64 }).notNull(),
    recordedAt: datetime('recorded_at', { mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('payment_correction_source').on(table.sourceId, table.direction),
    index('payment_correction_date').on(table.storeId, table.businessDate, table.id),
    index('payment_correction_order').on(table.orderId, table.id),
  ],
);
export const paymentCorrectionCloseImpacts = mysqlTable(
  'pos_rewrite_payment_correction_close_impacts',
  {
    id: varchar('id', { length: 100 }).primaryKey(),
    sourceId: char('source_id', { length: 36 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    closeId: varchar('close_id', { length: 32 }).notNull(),
    closeVersion: varchar('close_version', { length: 16 }).notNull(),
    recordedAt: datetime('recorded_at', { mode: 'string' }).notNull(),
  },
);
