import { bigint, datetime, int, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/**
 * @deprecated Check-ins live in the legacy Redis keys `check_in_{uid}` /
 * `check_in_list_{store}` (`checkins.ts`). Nothing in `src/` reads or writes this table; the
 * export remains only for `tests/fulfillment/mysql.integration.test.ts` (outside W8a).
 */
export const operatorCheckIns = mysqlTable('pos_rewrite_operator_checkins', {
  operatorId: varchar('operator_id', { length: 32 }).primaryKey(),
  storeId: bigint('store_id', { mode: 'bigint', unsigned: true }).notNull(),
  counterId: bigint('counter_id', { mode: 'bigint', unsigned: true }),
  expiresAt: datetime('expires_at', { mode: 'string', fsp: 3 }).notNull(),
  checkedInAt: datetime('checked_in_at', { mode: 'string', fsp: 3 }).notNull(),
});

export type InventoryIntegrationEvent = (
  | {
      kind: 'product.stock.changed';
      storeId: string;
      productId: string;
      stockBefore: number;
      stockAfter: number;
      actorId: string;
    }
  | { kind: 'product.visibility.changed'; storeId: string; productIds: string[]; actorId: string }
  | {
      kind: 'product.catalog.synchronization';
      importId: string;
      revision: number;
      productIds: string[];
      actorId: string;
    }
  | {
      kind: 'product.inventory.synchronization';
      storeId: string;
      productIds: string[];
      actorId: string;
      reason:
        | 'return'
        | 'exchange-return'
        | 'inventory-import'
        | 'legacy-rto'
        | 'legacy-delivery'
        | 'order-cancel';
    }
) & { requestId?: string };

export const administrationOutbox = mysqlTable('pos_rewrite_administration_outbox', {
  id: varchar('id', { length: 36 }).primaryKey(),
  kind: varchar('kind', { length: 64 }).notNull(),
  payload: json('payload').$type<InventoryIntegrationEvent>().notNull(),
  attempts: int('attempts').notNull(),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
  deliveredAt: datetime('delivered_at', { mode: 'string', fsp: 3 }),
});
