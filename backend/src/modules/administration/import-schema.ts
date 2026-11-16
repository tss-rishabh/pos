import {
  bigint,
  datetime,
  int,
  json,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';

export interface StockImportCommand {
  productId: string;
  storeId: string;
  movement: 'hold' | 'unhold' | 'none';
  quantity: number;
  available: boolean | null;
  archived: boolean | null;
}
export type StockImportCells = [string, string, string, string, string, string];
export const inventoryImports = mysqlTable('pos_rewrite_inventory_imports', {
  sequence: bigint('sequence', { mode: 'bigint', unsigned: true }).autoincrement().primaryKey(),
  id: varchar('id', { length: 36 }).notNull(),
  actorId: varchar('actor_id', { length: 32 }).notNull(),
  requestId: varchar('request_id', { length: 128 }),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  state: varchar('state', { length: 16 })
    .$type<'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'BLOCKED'>()
    .notNull(),
  errorCode: varchar('error_code', { length: 64 }),
  totalRows: int('total_rows').notNull(),
  processedRows: int('processed_rows').notNull(),
  successfulRows: int('successful_rows').notNull(),
  failedRows: int('failed_rows').notNull(),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
  updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
});
export const inventoryImportRows = mysqlTable(
  'pos_rewrite_inventory_import_rows',
  {
    importId: varchar('import_id', { length: 36 }).notNull(),
    rowNumber: int('record_number').notNull(),
    cells: json('cells').$type<StockImportCells>().notNull(),
    command: json('command').$type<StockImportCommand | null>(),
    state: varchar('state', { length: 16 })
      .$type<'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>()
      .notNull(),
    errorCode: varchar('error_code', { length: 64 }),
    message: varchar('message', { length: 255 }),
  },
  (table) => [primaryKey({ columns: [table.importId, table.rowNumber] })],
);
