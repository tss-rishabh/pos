import { int, json, mysqlTable, primaryKey, timestamp, varchar } from 'drizzle-orm/mysql-core';
import type { Draft } from '../domain/contracts.js';

export const drafts = mysqlTable(
  'pos_rewrite_drafts',
  {
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    id: varchar('id', { length: 36 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    counterId: varchar('counter_id', { length: 32 }).notNull(),
    version: int('version').notNull(),
    payload: json('payload').$type<Draft>().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.operatorId, table.id] })],
);
export const mutations = mysqlTable(
  'pos_rewrite_mutations',
  {
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    id: varchar('id', { length: 36 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    result: json('result').$type<Draft>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.operatorId, table.id] })],
);
