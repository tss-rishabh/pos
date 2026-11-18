import {
  bigint,
  datetime,
  double,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
} from 'drizzle-orm/mysql-core';
import { moneyHistoryPlatforms, pointHistoryPlatforms } from '../../../db/legacy-enums.js';

const historyFields = () => ({
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  userId: bigint('user_id', { mode: 'bigint' }).notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }),
  addedAmount: double('added_amt'),
  usedAmount: double('used_amt').notNull().default(0),
  balanceBefore: double('amt_before_update'),
  balanceAfter: double('amt_after_update'),
  comment: text('comment'),
  addedUser: bigint('added_user', { mode: 'bigint' }),
  createdAt: datetime('created_at', { mode: 'string' }),
  updatedAt: datetime('updated_at', { mode: 'string' }),
  expiry: datetime('expiry', { mode: 'string' }),
  expired: tinyint('is_expired'),
});
// Exact physical DOUBLE/nullable columns; the Python model omits product references.
export const walletMoneyHistory = mysqlTable('tss_money_history', {
  ...historyFields(),
  platform: mysqlEnum('platform', moneyHistoryPlatforms),
  productId: bigint('product_id', { mode: 'bigint' }),
});
export const walletPointHistory = mysqlTable('tss_point_history', {
  ...historyFields(),
  platform: mysqlEnum('platform', pointHistoryPlatforms),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull().default(0n),
});
