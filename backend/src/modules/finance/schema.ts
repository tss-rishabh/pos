import { datetime, json, mysqlTable, primaryKey, varchar } from 'drizzle-orm/mysql-core';

export const financeCommands = mysqlTable(
  'pos_rewrite_finance_commands',
  {
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    commandId: varchar('command_id', { length: 36 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    closeId: varchar('close_id', { length: 32 }),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.operatorId, table.commandId] })],
);
export interface PendingAlertReceipt {
  commandId: string;
  closeDate: string;
  pending: number;
  effectIds: string[];
  delivery: 'pending' | 'not-required';
}
export const financeAlertCommands = mysqlTable('pos_rewrite_finance_alert_commands', {
  commandId: varchar('command_id', { length: 36 }).primaryKey(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  result: json('result').$type<PendingAlertReceipt>(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
