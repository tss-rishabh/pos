import {
  bigint,
  datetime,
  decimal,
  double,
  float,
  int,
  json,
  mysqlTable,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';

/** Exact physical projection: mysql-import-benefit-profile-schema.json and
 * mysql-customer-contact-schema.json. Mapping only; no legacy DDL. */
export const importCouponUsers = mysqlTable('coupons_users', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  couponId: bigint('c_id', { mode: 'bigint' }).notNull(),
  customerId: bigint('user_id', { mode: 'bigint' }).notNull(),
  allowed: bigint('coupon_allowed_count', { mode: 'bigint' }).notNull(),
  used: bigint('coupon_used_count', { mode: 'bigint' }).notNull(),
  monthlyAllowed: bigint('coupon_month_allowed_count', { mode: 'bigint' }).notNull(),
});
export const importCouponLogs = mysqlTable('order_coupon_log', {
  id: int('id').autoincrement().primaryKey(),
  customerId: bigint('user_id', { mode: 'bigint' }).notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  couponId: bigint('coupon_id', { mode: 'bigint' }).notNull(),
  status: int('status').notNull(),
  createdAt: datetime('created_at', { mode: 'string' }),
  updatedAt: datetime('updated_at', { mode: 'string' }),
});
export const importFreebieGrants = mysqlTable('order_freebies', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  lineId: bigint('has_product_id', { mode: 'bigint' }).notNull(),
  productId: bigint('freebie_prod_id', { mode: 'bigint' }).notNull(),
  freebieId: bigint('freebie_id', { mode: 'bigint' }).notNull(),
  saleId: bigint('freebie_sale_id', { mode: 'bigint' }).notNull(),
  level: varchar('grant_level', { length: 12 }).notNull(),
  triggerId: bigint('trigger_id', { mode: 'bigint' }).notNull(),
  triggerKey: varchar('trigger_key', { length: 255 }).notNull(),
  mov: int('mov').notNull(),
  qualifiedValue: decimal('qualified_value', { precision: 12, scale: 2 }).notNull(),
  exclusive: tinyint('is_exclusive_order').notNull(),
  baseField: varchar('base_field', { length: 16 }),
  status: varchar('status', { length: 12 }).notNull(),
  revokedAt: datetime('revoked_at', { mode: 'string' }),
  reason: varchar('revoke_reason', { length: 255 }),
  createdAt: datetime('created_at', { mode: 'string' }),
  updatedAt: datetime('updated_at', { mode: 'string' }),
});
export const importFreebieTriggers = mysqlTable('order_freebie_triggers', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  grantId: bigint('order_freebie_id', { mode: 'bigint' }).notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  lineId: bigint('has_product_id', { mode: 'bigint' }).notNull(),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull(),
  contribution: decimal('contribution', { precision: 12, scale: 2 }).notNull(),
  createdAt: datetime('created_at', { mode: 'string' }),
});
/** Narrow physical HP columns omitted by the source-generated model. */
export const importBenefitLines = mysqlTable('has_products', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull(),
  type: varchar('type', { length: 255 }),
  price: double('price').notNull(),
  discount: float('disc').notNull(),
  refundable: float('amount_to_be_refunded').notNull(),
});
export const importBirthdayClaims = mysqlTable('pos_rewrite_import_birthday_claims', {
  operationId: varchar('operation_id', { length: 36 }).primaryKey(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  claimId: varchar('claim_id', { length: 36 }).notNull(),
  receipt: json('receipt').$type<unknown>().notNull(),
  proofHash: varchar('proof_hash', { length: 64 }).notNull(),
});
export const importBenefitCouponControls = mysqlTable('coupons', { id: int('id').primaryKey() });
