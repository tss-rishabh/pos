import { json, mysqlTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import type { CopyCommand, CopyReview } from './contracts.js';
import type { CopyCancellationReceipt } from './cancellation-contracts.js';
export const orderCopyReviews = mysqlTable('pos_rewrite_order_copy_reviews', {
  id: varchar('id', { length: 36 }).primaryKey(),
  checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
  operatorId: varchar('operator_id', { length: 32 }).notNull(),
  data: json('data').$type<CopyReview>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
export const orderCopyCommands = mysqlTable(
  'pos_rewrite_order_copy_commands',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    reviewId: varchar('review_id', { length: 36 }).notNull(),
    checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    data: json('data').$type<CopyCommand | CopyCancellationReceipt>().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [uniqueIndex('ux_order_copy_review').on(table.reviewId)],
);
export const orderCopyCancellations = mysqlTable(
  'pos_rewrite_order_copy_cancellations',
  {
    copyId: varchar('copy_id', { length: 36 }).primaryKey(),
    cancellationId: varchar('cancellation_id', { length: 36 }).notNull(),
    checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    receiptHash: varchar('receipt_hash', { length: 64 }).notNull(),
    receipt: json('receipt').$type<CopyCancellationReceipt>().notNull(),
    originalCommand: json('original_command').$type<CopyCommand | null>(),
  },
  (table) => [uniqueIndex('ux_order_copy_cancellation').on(table.cancellationId)],
);
