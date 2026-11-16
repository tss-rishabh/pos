import {
  bigint,
  datetime,
  double,
  index,
  mysqlTable,
  primaryKey,
  text,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';

const historyFields = () => ({
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  userId: bigint('user_id', { mode: 'bigint' }).notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }),
  addedAmount: double('added_amt'),
  usedAmount: double('used_amt').notNull().default(0),
  balanceBefore: double('amt_before_update'),
  balanceAfter: double('amt_after_update'),
  comment: text('comment'),
  platform: varchar('platform', { length: 40 }),
  addedUser: bigint('added_user', { mode: 'bigint' }),
  createdAt: datetime('created_at', { mode: 'string' }),
  updatedAt: datetime('updated_at', { mode: 'string' }),
  expiry: datetime('expiry', { mode: 'string' }),
  expired: tinyint('is_expired'),
});
// Exact physical DOUBLE/nullable columns; the Python model omits product references.
export const walletMoneyHistory = mysqlTable('tss_money_history', {
  ...historyFields(),
  productId: bigint('product_id', { mode: 'bigint' }),
});
export const walletPointHistory = mysqlTable('tss_point_history', {
  ...historyFields(),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull().default(0n),
});
export const walletAdjustments = mysqlTable(
  'pos_rewrite_wallet_adjustments',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    executionId: varchar('execution_id', { length: 36 }).notNull(),
    request: text('request_json').notNull(),
    result: text('result_json'),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (table) => [
    index('ix_wallet_adjustment_customer').on(table.customerId, table.createdAt, table.id),
  ],
);
export const walletConsumptions = mysqlTable(
  'pos_rewrite_wallet_consumptions',
  {
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    historyId: varchar('history_id', { length: 32 }).notNull(),
    asset: varchar('asset', { length: 8 }).notNull(),
    usedBefore: double('used_before').notNull(),
    usedAfter: double('used_after').notNull(),
  },
  (table) => [primaryKey({ columns: [table.operationId, table.historyId] })],
);
