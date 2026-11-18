import {
  bigint,
  datetime,
  double,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';
import { moneyHistoryPlatforms, pointHistoryPlatforms } from '../../../db/legacy-enums.js';

/** Physical types/defaults from mysql-pending-cancellation-benefits-schema.json. */
const allocationFields = () => ({
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull().default(0n),
  used: double('used_amount').notNull().default(0),
  createdAt: datetime('created_at', { mode: 'string' }),
  updatedAt: datetime('updated_at', { mode: 'string' }),
});
export const cancellationMoneyAllocations = mysqlTable('order_tss_money', {
  ...allocationFields(),
  historyId: bigint('tss_money_id', { mode: 'bigint' }).notNull().default(0n),
  returned: double('tss_money_return').default(0),
});
export const cancellationPointAllocations = mysqlTable('order_tss_point', {
  ...allocationFields(),
  historyId: bigint('tss_point_id', { mode: 'bigint' }).notNull().default(0n),
  returned: double('tss_point_return').default(0),
});
const historyFields = () => ({
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey(),
  userId: bigint('user_id', { mode: 'bigint' }).notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }),
  lineId: bigint('has_product_id', { mode: 'bigint' }),
  added: double('added_amt'),
  used: double('used_amt').notNull().default(0),
  before: double('amt_before_update'),
  after: double('amt_after_update'),
  comment: text('comment'),
  operatorId: bigint('added_user', { mode: 'bigint' }),
  createdAt: datetime('created_at', { mode: 'string' }),
  updatedAt: datetime('updated_at', { mode: 'string' }),
  expiry: datetime('expiry', { mode: 'string' }),
  expired: tinyint('is_expired').default(0),
  bulk: tinyint('is_bulk_upload').default(0),
});
export const cancellationMoneyHistory = mysqlTable('tss_money_history', {
  ...historyFields(),
  // A non-member platform is written as '' (see storedEnumValue).
  platform: mysqlEnum('platform', moneyHistoryPlatforms).$type<
    (typeof moneyHistoryPlatforms)[number] | ''
  >(),
  productId: bigint('product_id', { mode: 'bigint' }).default(0n),
});
export const cancellationPointHistory = mysqlTable('tss_point_history', {
  ...historyFields(),
  platform: mysqlEnum('platform', pointHistoryPlatforms).$type<
    (typeof pointHistoryPlatforms)[number] | ''
  >(),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull().default(0n),
  gameId: bigint('game_category_id', { mode: 'bigint' }).default(0n),
});

export interface MembershipStateRow {
  attribute: 'EXCLUSIVE_MEMBER' | 'EXCLUSIVE_EXPIRY';
  value: string | null;
  active: number | null;
  createdAt: string;
  updatedAt: string;
  hash: string;
}
export const cancellationMembershipRows = mysqlTable(
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
export const cancellationMembershipVersions = mysqlTable('pos_rewrite_membership_versions', {
  customerId: bigint('customer_id', { mode: 'bigint' }).primaryKey(),
  revision: bigint('revision', { mode: 'bigint', unsigned: true }).notNull(),
});
export const cancellationMembershipProvenance = mysqlTable(
  'pos_rewrite_cancellation_membership_provenance',
  {
    orderId: bigint('order_id', { mode: 'bigint' }).primaryKey(),
    customerId: bigint('customer_id', { mode: 'bigint' }).notNull(),
    revision: bigint('revision', { mode: 'bigint', unsigned: true }).notNull(),
    headerHash: varchar('header_hash', { length: 64 }).notNull(),
    before: json('before_state').$type<MembershipStateRow[]>().notNull(),
    confirmed: json('confirmed_state').$type<MembershipStateRow[]>().notNull(),
    entityDigest: varchar('entity_digest', { length: 64 }),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
    contract: varchar('contract_version', { length: 60 }).notNull(),
    operationId: varchar('operation_id', { length: 36 }).notNull(),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (table) => [index('ix_cancel_membership_customer').on(table.customerId, table.revision)],
);
