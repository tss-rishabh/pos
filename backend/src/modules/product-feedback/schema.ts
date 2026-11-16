import {
  bigint,
  datetime,
  float,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { FeedbackReceipt } from './contracts.js';

/** Verified physical projection; never migrate or constrain this shared legacy table. */
export const productRatings = mysqlTable('product_rating_user', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  customerId: bigint('user_id', { mode: 'bigint' }).notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull(),
  optionId: bigint('product_rating_option_id', { mode: 'bigint' }),
  rating: float('rating'),
  platform: mysqlEnum('platform', ['ANDROID', 'IOS', 'WEB']),
  comment: varchar('comment', { length: 255 }),
  isDefault: tinyint('is_default'),
  createdAt: datetime('created_at', { mode: 'string' }),
  updatedAt: datetime('updated_at', { mode: 'string' }),
});
export const feedbackReceipts = mysqlTable('pos_rewrite_product_feedback_receipts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  operatorId: varchar('operator_id', { length: 32 }).notNull(),
  storeId: varchar('store_id', { length: 32 }).notNull(),
  counterId: varchar('counter_id', { length: 32 }).notNull(),
  checkoutId: varchar('checkout_id', { length: 36 }).notNull(),
  customerId: varchar('customer_id', { length: 32 }).notNull(),
  orderId: varchar('order_id', { length: 32 }).notNull(),
  productId: varchar('product_id', { length: 32 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  checkoutVersion: int('checkout_version').notNull(),
  receipt: json('receipt').$type<FeedbackReceipt>().notNull(),
  requestId: varchar('request_id', { length: 128 }),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
});
