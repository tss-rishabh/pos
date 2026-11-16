import { datetime, index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { BarcodeReceipt } from './domain.js';
export const barcodeAssignmentReceipts = mysqlTable(
  'pos_rewrite_barcode_assignments',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    inputHash: varchar('input_hash', { length: 64 }).notNull(),
    productId: varchar('product_id', { length: 19 }).notNull(),
    barcode: varchar('barcode', { length: 19 }).notNull(),
    result: json('result').$type<BarcodeReceipt>().notNull(),
    createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  },
  (table) => [index('barcode_assignment_actor_created').on(table.actorId, table.createdAt)],
);
