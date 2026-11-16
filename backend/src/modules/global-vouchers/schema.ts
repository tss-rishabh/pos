import {
  bigint,
  char,
  datetime,
  index,
  int,
  json,
  mysqlTable,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { CustomerContactBinding } from '../checkout/customer-contact-authority.js';
import type { VoucherReceipt } from './contracts.js';

export const voucherSelections = mysqlTable(
  'pos_rewrite_voucher_selections',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    actorVersion: char('actor_version', { length: 64 }).notNull(),
    contact: json('contact_json').$type<CustomerContactBinding>().notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    consumedBy: varchar('consumed_by', { length: 36 }),
  },
  (t) => [index('ix_voucher_selection_expiry').on(t.expiresAt, t.id)],
);
export const voucherOperations = mysqlTable(
  'pos_rewrite_voucher_operations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    customerId: varchar('customer_id', { length: 32 }).notNull(),
    kind: varchar('kind', { length: 16 }).$type<'issuance' | 'conversion'>().notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    executionId: varchar('execution_id', { length: 36 }).notNull(),
    storeId: varchar('store_id', { length: 32 }),
    checkoutId: varchar('checkout_id', { length: 36 }),
    result: json('result_json').$type<VoucherReceipt>(),
    errorCode: varchar('error_code', { length: 40 }),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (t) => [index('ix_voucher_operation_actor').on(t.operatorId, t.createdAt, t.id)],
);
export const voucherPinBudgets = mysqlTable('pos_rewrite_voucher_pin_budgets', {
  voucherId: varchar('voucher_id', { length: 32 }).primaryKey(),
  failures: int('failures').notNull(),
  windowStartedAt: bigint('window_started_at', { mode: 'number' }).notNull(),
});
