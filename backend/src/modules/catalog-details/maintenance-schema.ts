import {
  boolean,
  datetime,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { CommandMetadata, MaintenancePayload } from './maintenance-domain.js';
export const catalogMaintenanceCommands = mysqlTable('pos_rewrite_catalog_commands', {
  id: varchar('id', { length: 36 }).primaryKey(),
  kind: mysqlEnum('kind', ['inventory-pull', 'product-troubleshoot']).notNull(),
  ownerId: varchar('owner_id', { length: 32 }).notNull(),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  inputHash: varchar('input_hash', { length: 64 }).notNull(),
  state: mysqlEnum('state', ['PENDING', 'RUNNING', 'SUCCEEDED', 'UNCERTAIN', 'FAILED']).notNull(),
  metadata: json('metadata').$type<CommandMetadata>().notNull(),
  localApplied: boolean('local_applied').notNull(),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
  errorCode: varchar('error_code', { length: 64 }),
});
export const catalogMaintenanceDeliveries = mysqlTable('pos_rewrite_catalog_deliveries', {
  id: varchar('id', { length: 36 }).primaryKey(),
  commandId: varchar('command_id', { length: 36 }).notNull(),
  ordinal: int('ordinal').notNull(),
  targetIdentity: varchar('target_identity', { length: 64 }).notNull(),
  payload: json('payload').$type<MaintenancePayload>().notNull(),
  state: mysqlEnum('state', ['PENDING', 'SENDING', 'DELIVERED', 'UNCERTAIN', 'FAILED']).notNull(),
  leaseUntil: datetime('lease_until', { mode: 'string', fsp: 3 }),
  updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
  errorCode: varchar('error_code', { length: 64 }),
  reconciliationId: varchar('reconciliation_id', { length: 36 }),
  reconciliationOutcome: mysqlEnum('reconciliation_outcome', ['delivered', 'not-delivered']),
  reconciledBy: varchar('reconciled_by', { length: 32 }),
  leaseToken: varchar('lease_token', { length: 36 }),
});
export const catalogMaintenanceLocks = mysqlTable('pos_rewrite_catalog_locks', {
  id: varchar('id', { length: 64 }).primaryKey(),
});
export const catalogMaintenanceReconciliations = mysqlTable('pos_rewrite_catalog_reconciliations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  commandId: varchar('command_id', { length: 36 }).notNull(),
  deliveryId: varchar('delivery_id', { length: 36 }).notNull(),
  outcome: mysqlEnum('outcome', ['delivered', 'not-delivered']).notNull(),
  actorId: varchar('actor_id', { length: 32 }).notNull(),
  requestId: varchar('request_id', { length: 128 }).notNull(),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
});
