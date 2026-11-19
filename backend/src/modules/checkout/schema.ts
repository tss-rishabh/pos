import { int, json, mysqlTable, timestamp, varchar, uniqueIndex } from 'drizzle-orm/mysql-core';
import type { CheckoutState } from './contracts.js';

/**
 * @deprecated W4 moved checkout sales to Redis (`session-store.ts`, `pos:checkout:{id}`); no W4
 * code reads or writes this table. Kept only for `customer-contacts/commit.ts` (a feature AGENTS.md
 * removes) and `tests/customer-profile.mysql.integration.test.ts`, which other owners must migrate.
 */
export const checkoutSessions = mysqlTable(
  'pos_rewrite_checkout_sessions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    clientDraftId: varchar('client_draft_id', { length: 36 }),
    version: int('version').notNull(),
    state: json('state').$type<CheckoutState>().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [uniqueIndex('ux_checkout_operator_draft').on(table.operatorId, table.clientDraftId)],
);
