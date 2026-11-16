import { datetime, int, json, mysqlTable, primaryKey, varchar } from 'drizzle-orm/mysql-core';
export const parentStoreImportAudits = mysqlTable(
  'pos_rewrite_parent_store_import_audits',
  {
    importId: varchar('import_id', { length: 36 }).notNull(),
    rowNumber: int('record_number').notNull(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    storeId: varchar('store_id', { length: 19 }).notNull(),
    parentId: varchar('parent_id', { length: 19 }).notNull(),
    before: json('before_json')
      .$type<
        { id: string; productId: string; stock: number; available: boolean; archived: boolean }[]
      >()
      .notNull(),
    afterIds: json('after_ids').$type<string[]>().notNull(),
    resetIds: json('reset_ids').$type<string[]>().notNull(),
    createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.importId, table.rowNumber] })],
);
