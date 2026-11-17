import { bigint, index, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
export const returnRepairObligations = mysqlTable(
  'pos_rewrite_return_repair_obligations',
  {
    returnId: varchar('return_id', { length: 36 }).primaryKey(),
    commandId: varchar('command_id', { length: 36 }).notNull().unique(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    authVersion: varchar('auth_version', { length: 64 }).notNull(),
    role: int('role').notNull(),
    userType: int('user_type').notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    orderId: varchar('order_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    rejectionHash: varchar('rejection_hash', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    state: varchar('state', { length: 16 }).$type<'PENDING' | 'BLOCKED' | 'LINKED'>().notNull(),
    errorCode: varchar('error_code', { length: 64 }),
    version: int('version', { unsigned: true }).notNull(),
    recoveryActorId: varchar('recovery_actor_id', { length: 32 }),
    recoveryAuthVersion: varchar('recovery_auth_version', { length: 64 }),
    createdAt: bigint('created_at_ms', { mode: 'number', unsigned: true }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number', unsigned: true }).notNull(),
  },
  (table) => [
    index('ix_return_repair_pending').on(table.state, table.createdAt),
    index('ix_return_repair_scope').on(table.storeId, table.orderId, table.createdAt),
  ],
);
export const returnRepairRecoveries = mysqlTable('pos_rewrite_return_repair_recoveries', {
  id: varchar('id', { length: 36 }).primaryKey(),
  returnId: varchar('return_id', { length: 36 }).notNull(),
  actorId: varchar('actor_id', { length: 32 }).notNull(),
  expectedVersion: int('expected_version', { unsigned: true }).notNull(),
  createdAt: bigint('created_at_ms', { mode: 'number', unsigned: true }).notNull(),
});
