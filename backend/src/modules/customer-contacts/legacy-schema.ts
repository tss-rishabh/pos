import {
  bigint,
  datetime,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';

/** Mapping only: mysql-customer-contact-schema.json +mysql-global-benefits-schema.json. No legacy DDL. */
export const contactUsers = mysqlTable('users', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  email: varchar('email', { length: 96 }).notNull(),
  telephone: varchar('telephone', { length: 32 }).notNull(),
  userType: varchar('user_type', { length: 255 }).notNull(),
  status: tinyint('status').notNull(),
  blocked: tinyint('is_block'),
  disabled: tinyint('is_disabled'),
  emailVerified: int('is_email_verified'),
  twoFactor: tinyint('is_two_fa').notNull(),
});
export const contactUserEav = mysqlTable(
  'user_eav',
  {
    entity: varchar('entity', { length: 255 }).notNull(),
    attribute: mysqlEnum('attribute', [
      'EXCLUSIVE_NOTIFY',
      'EXCLUSIVE_EXPIRY',
      'EXCLUSIVE_MEMBER',
    ]).notNull(),
    value: text('value'),
    active: tinyint('is_active'),
    createdAt: timestamp('created_at', { mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.entity, table.attribute] })],
);
export const contactUserDetailLogs = mysqlTable(
  'user_detail_logs',
  {
    id: bigint('id', { mode: 'bigint' }).autoincrement().notNull(),
    userId: bigint('user_id', { mode: 'bigint' }).notNull(),
    userType: tinyint('user_type').notNull(),
    kind: mysqlEnum('type', ['TELEPHONE', 'EMAIL']).notNull(),
    previousValue: varchar('previous_value', { length: 255 }),
    newValue: varchar('new_value', { length: 255 }),
    addedBy: bigint('added_by', { mode: 'bigint' }),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.userId] })],
);
export const contactMembershipCopies = mysqlTable('user_email_membership_copy_logs', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  userId: bigint('user_id', { mode: 'bigint' }).notNull(),
  oldEmail: varchar('old_email', { length: 255 }).notNull(),
  newEmail: varchar('new_email', { length: 255 }).notNull(),
  sharedUserIds: text('shared_user_ids').notNull(),
  exclusiveExpiry: varchar('exclusive_expiry', { length: 64 }).notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
export const contactJuspayCustomers = mysqlTable('jp_customers', {
  id: int('id', { unsigned: true }).autoincrement().primaryKey(),
  userId: int('user'),
  email: varchar('email', { length: 100 }),
  deletedAt: timestamp('deleted_at', { mode: 'string' }),
});
export const contactGiftVouchers = mysqlTable('gift_vouchers', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  recipient: varchar('to_id', { length: 255 }).notNull(),
});
export const contactWelcomeOffers = mysqlTable('welcome_offer', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  email: varchar('email_id', { length: 55 }).notNull(),
});
export const contactBankTransfers = mysqlTable('bank_transfer_requests', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  status: mysqlEnum('status', [
    'PENDING',
    'SUCCESS',
    'ERROR',
    'FAILED',
    'REVERSED',
    'REQUESTED',
  ]).notNull(),
});
export const contactRefundAlternatives = mysqlTable('refund_alternate_payment_details', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  refundRequestId: bigint('refund_request_id', { mode: 'bigint' }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  status: mysqlEnum('status', ['PENDING', 'MAIL_SENT', 'SUBMITTED']).notNull(),
});
export const contactRefundRequests = mysqlTable('refund_requests', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  userId: bigint('user_id', { mode: 'bigint' }).notNull(),
  completed: mysqlEnum('is_completed', ['PENDING', 'COMPLETED', 'REJECTED', 'FAILED']).notNull(),
});
export const contactCoupons = mysqlTable('coupons', {
  id: int('id').primaryKey(),
  employee: tinyint('is_employee_coupon'),
  deleted: int('is_deleted').notNull(),
  start: datetime('start_date', { mode: 'string' }).notNull(),
  end: datetime('end_date', { mode: 'string' }).notNull(),
});
export const contactCouponUsers = mysqlTable('coupons_users', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  couponId: bigint('c_id', { mode: 'bigint' }).notNull(),
  userId: bigint('user_id', { mode: 'bigint' }).notNull(),
});
