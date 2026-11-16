import { bigint, datetime, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/** Read projection only: physical metadata verified; all three text filters use latin1_swedish_ci. */
export const specialPermissionActivity = mysqlTable('pos_special_permission_activity_log', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  actorId: bigint('pos_user_id', { mode: 'bigint' }).notNull(),
  platform: varchar('platform', { length: 255 }).notNull(),
  recipient: varchar('recipient', { length: 45 }),
  comment: varchar('comment', { length: 255 }).notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
