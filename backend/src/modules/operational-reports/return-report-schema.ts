import { bigint, double, mysqlEnum, mysqlTable } from 'drizzle-orm/mysql-core';
/** Source unmanaged has_product_id is BIGINT NULL in verified live metadata. Read-only. */
export const ReturnReportMoneyHistory = mysqlTable('tss_money_history', {
  orderId: bigint('order_id', { mode: 'number' }),
  hasProductId: bigint('has_product_id', { mode: 'bigint' }),
  platform: mysqlEnum('platform', [
    'ORDER_PLACED',
    'ORDER_CANCELLED',
    'ORDER_REFUND',
    'ORDER_MONEY',
    'TSS_MONEY_EXPIRED',
    'TSS_MONEY_EARNED',
    'ORDER_RETURN',
    'PAYMENT_FAILED',
    'DONATION_MONEY',
    'PRODUCT_RETURN',
    'COURIER_COMPENSATION',
    'DEFECTIVE_PRODUCT',
    'PRODUCT_MISSING',
    'PRODUCT_OUT_OF_STOCK',
    'MISC_COMPENSATION',
    'REFERRAL_MONEY',
    'EXCHANGE',
    'FIRST_ORDER_RETURN_BONUS',
    'TESTING',
  ]),
  addedAmount: double('added_amt'),
});
