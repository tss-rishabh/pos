import {
  bigint,
  datetime,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';

/** Physical types from mysql-legacy-fulfillment-schema.json. Never migrated. */
export const legacyHyperlocalLogs = mysqlTable('hyperlocal_order_log', {
  id: int('id').autoincrement().primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  borzoId: bigint('borzo_id', { mode: 'bigint' }).notNull(),
  action: mysqlEnum('action', [
    'ACCEPTED',
    'DECLINED',
    'NO_ACTION',
    'CREATION_FAILED',
    'CONVERT_ONLINE',
  ]).notNull(),
  mainStoreId: int('main_location_id'),
  createdInBorzo: tinyint('is_created_in_borzo'),
  packed: tinyint('is_pack'),
  rto: tinyint('is_rto'),
  received: tinyint('rto_recieved'),
  refunded: tinyint('is_refunded'),
  posAdminId: int('pos_admin_id').notNull(),
  sourceTracking: varchar('source_tracking_url', { length: 255 }),
  destinationTracking: varchar('destination_tracking_url', { length: 255 }),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  /** Reviewed nullable unset-event compatibility contract; never changed by application DDL. */
  deliveryExceptionDate: datetime('delivery_exception_date', { mode: 'string' }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string' }).notNull(),
});
export const legacyCommands = mysqlTable('pos_rewrite_legacy_fulfillment_commands', {
  id: varchar('command_id', { length: 36 }).primaryKey().notNull(),
  actorId: varchar('actor_id', { length: 20 }).notNull(),
  storeId: varchar('store_id', { length: 20 }).notNull(),
  orderId: varchar('order_id', { length: 20 }).notNull(),
  action: varchar('action', { length: 20 }).notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  result: json('result_json').$type<unknown>(),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  createdAt: bigint('created_at_ms', { mode: 'number', unsigned: true }).notNull(),
});
export const legacyRtoReceipts = mysqlTable('pos_rewrite_legacy_rto_receipts', {
  orderId: bigint('order_id', { mode: 'bigint' }).primaryKey().notNull(),
  storeId: bigint('store_id', { mode: 'bigint' }).notNull(),
  commandId: varchar('command_id', { length: 36 }).notNull().unique(),
  receipt: json('receipt_json').$type<unknown>().notNull(),
  createdAt: bigint('created_at_ms', { mode: 'number', unsigned: true }).notNull(),
});
