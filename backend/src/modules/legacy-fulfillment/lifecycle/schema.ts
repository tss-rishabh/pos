import { bigint, int, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type {
  DeliverySnapshot,
  LifecycleOrderState,
  LifecycleReceipt,
  ProviderRequest,
  ProviderResult,
} from './contracts.js';
import type { StoredLifecycleInput } from './command-input.js';
export const deliveryOrders = mysqlTable('pos_rewrite_local_delivery_orders', {
  orderId: bigint('order_id', { mode: 'bigint' }).primaryKey().notNull(),
  state: json('state_json').$type<LifecycleOrderState>().notNull(),
  version: int('version').notNull(),
  updatedAt: bigint('updated_at_ms', { mode: 'number', unsigned: true }).notNull(),
});
export const deliveryCommands = mysqlTable('pos_rewrite_local_delivery_commands', {
  id: varchar('command_id', { length: 36 }).primaryKey().notNull(),
  phase: varchar('phase', { length: 24 }).notNull(),
  state: json('state_json').$type<LifecycleReceipt>().notNull(),
  snapshot: json('snapshot_json').$type<DeliverySnapshot>().notNull(),
  input: json('input_json').$type<StoredLifecycleInput>().notNull(),
  stage: varchar('stage', { length: 32 }).notNull(),
});
export const deliveryCalls = mysqlTable('pos_rewrite_local_delivery_calls', {
  id: varchar('call_id', { length: 36 }).primaryKey().notNull(),
  commandId: varchar('command_id', { length: 36 }).notNull(),
  sequence: int('sequence_no').notNull(),
  attempts: int('attempts').notNull(),
  request: json('request_json').$type<ProviderRequest>().notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  createdAt: bigint('created_at_ms', { mode: 'number', unsigned: true }).notNull(),
  result: json('result_json').$type<ProviderResult>(),
  claimedAt: bigint('claimed_at_ms', { mode: 'number', unsigned: true }),
  completedAt: bigint('completed_at_ms', { mode: 'number', unsigned: true }),
});
export const deliveryJobs = mysqlTable('pos_rewrite_local_delivery_jobs', {
  id: varchar('job_id', { length: 36 }).primaryKey().notNull(),
  commandId: varchar('command_id', { length: 36 }).notNull(),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  storeId: bigint('store_id', { mode: 'bigint' }).notNull(),
  kind: varchar('kind', { length: 32 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  dueAt: bigint('due_at_ms', { mode: 'number', unsigned: true }).notNull(),
  claimedAt: bigint('claimed_at_ms', { mode: 'number', unsigned: true }),
  result: json('result_json').$type<Record<string, string | number | boolean>>(),
});
