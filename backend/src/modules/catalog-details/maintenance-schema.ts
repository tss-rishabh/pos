import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/**
 * @deprecated `pos_rewrite_catalog_locks` is replaced by the Redis lock
 * `pos:lock:catalog:barcode-mutations` (`./locks.ts`). Kept only so
 * `administration/barcodes/locks.ts` compiles until its owner moves to Redis.
 */
export const catalogMaintenanceLocks = mysqlTable('pos_rewrite_catalog_locks', {
  id: varchar('id', { length: 64 }).primaryKey(),
});
