import {
  bigint,
  datetime,
  float,
  mysqlEnum,
  mysqlTable,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';

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
