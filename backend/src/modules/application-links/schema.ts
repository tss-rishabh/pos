import { sql } from 'drizzle-orm';
import { datetime, int, mysqlTable } from 'drizzle-orm/mysql-core';

/** Production `pos_to_app_logs` (legacy `UserToApp` raw INSERT, core/views.py:3189-3195). */
export const sourceApplicationScans = mysqlTable('pos_to_app_logs', {
  id: int('id').primaryKey().autoincrement(),
  storeId: int('store_id').notNull().default(0),
  scannedAt: datetime('scanned_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  createdAt: datetime('created_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at', { mode: 'string' })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
