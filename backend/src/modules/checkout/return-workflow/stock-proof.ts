import { bigint, datetime, index, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const exchangeStockContract = 'pos-exchange-stock-v1';
/** Written only by the reviewed upstream compatibility transaction, never inferred from HTTP. */
export const exchangeStockConfirmations = mysqlTable(
  'pos_rewrite_exchange_stock_confirmations',
  {
    orderId: bigint('order_id', { mode: 'bigint' }).primaryKey(),
    parentOrderId: bigint('parent_order_id', { mode: 'bigint' }).notNull(),
    parentLineId: bigint('parent_has_product_id', { mode: 'bigint' }).notNull(),
    lineId: bigint('has_product_id', { mode: 'bigint' }).notNull(),
    storeId: bigint('store_id', { mode: 'bigint' }).notNull(),
    counterId: bigint('counter_id', { mode: 'bigint' }).notNull(),
    productId: bigint('product_id', { mode: 'bigint' }).notNull(),
    quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
    contractVersion: varchar('contract_version', { length: 40 }).notNull(),
    confirmedAt: datetime('confirmed_at', { mode: 'string' }).notNull(),
  },
  (table) => [
    index('ix_exchange_stock_parent').on(table.parentOrderId, table.parentLineId, table.orderId),
  ],
);
