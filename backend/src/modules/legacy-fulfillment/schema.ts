import { bigint, datetime, int, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/** Physical types from mysql-legacy-fulfillment-schema.json. Never migrated. */
export const legacyHyperlocalLogs = mysqlTable('hyperlocal_order_log', {
  id: int('id').autoincrement().primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  borzoId: bigint('borzo_id', { mode: 'bigint' }).notNull(),
  action: varchar('action', { length: 255 }).notNull(),
  mainStoreId: int('main_location_id'),
  createdInBorzo: int('is_created_in_borzo'),
  packed: int('is_pack'),
  rto: int('is_rto'),
  received: int('rto_recieved'),
  refunded: int('is_refunded'),
  posAdminId: int('pos_admin_id').notNull(),
  sourceTracking: varchar('source_tracking_url', { length: 255 }),
  destinationTracking: varchar('destination_tracking_url', { length: 255 }),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  /** Reviewed nullable unset-event compatibility contract; never changed by application DDL. */
  deliveryExceptionDate: datetime('delivery_exception_date', { mode: 'string' }),
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
