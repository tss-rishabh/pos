import { datetime, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

// Stable Google subject is the identity; a verified work email enrolls only an
// existing active POS operator. A reassigned email cannot silently replace it.
export const googleIdentities = mysqlTable(
  'pos_rewrite_operator_google_identities',
  {
    subject: varchar('subject', { length: 255 }).primaryKey(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
  },
  (table) => [uniqueIndex('ux_google_identity_operator').on(table.operatorId)],
);
