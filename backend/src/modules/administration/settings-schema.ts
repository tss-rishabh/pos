import { bigint, datetime, int, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { SettingsEffect, SettingsMutationResult } from './settings-domain.js';

export const settingsEffects = mysqlTable('pos_rewrite_settings_effects', {
  sequence: bigint('sequence', { mode: 'bigint', unsigned: true }).autoincrement().primaryKey(),
  id: varchar('id', { length: 36 }).notNull(),
  partitionKey: varchar('partition_key', { length: 96 }).notNull(),
  kind: varchar('kind', { length: 40 }).notNull(),
  payload: json('payload').$type<SettingsEffect>().notNull(),
  attempts: int('attempts').notNull(),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
  deliveredAt: datetime('delivered_at', { mode: 'string', fsp: 3 }),
});
export const settingsMutations = mysqlTable('pos_rewrite_settings_mutations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  actorId: varchar('actor_id', { length: 32 }).notNull(),
  hash: varchar('hash', { length: 64 }).notNull(),
  result: json('result').$type<SettingsMutationResult>().notNull(),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
});
export const ecommerceChanges = mysqlTable('pos_rewrite_ecommerce_changes', {
  storeId: bigint('store_id', { mode: 'bigint', unsigned: true }).primaryKey(),
  lockedUntil: datetime('locked_until', { mode: 'string', fsp: 3 }).notNull(),
});
