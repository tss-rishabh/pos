import {
  datetime,
  int,
  longtext,
  mysqlSchema,
  mysqlTable,
  smallint,
  varchar,
} from 'drizzle-orm/mysql-core';

/** Read-only projections of the exact saved physical metadata, not legacy migrations. */
export const administrationHistoryLog = mysqlTable('django_admin_log', {
  id: int('id').primaryKey().notNull(),
  actionTime: datetime('action_time', { mode: 'string', fsp: 6 }).notNull(),
  objectId: longtext('object_id'),
  objectRepresentation: varchar('object_repr', { length: 200 }).notNull(),
  actionFlag: smallint('action_flag', { unsigned: true }).notNull(),
  changeMessage: longtext('change_message').notNull(),
  contentTypeId: int('content_type_id'),
  actorId: int('user_id').notNull(),
});
export const administrationHistoryContentType = mysqlTable('django_content_type', {
  id: int('id').primaryKey().notNull(),
  appLabel: varchar('app_label', { length: 100 }).notNull(),
  model: varchar('model', { length: 100 }).notNull(),
});
/** The supplied reader's log FK points here. This binding must never be guessed from matching IDs. */
export const administrationHistoryAuthActor = mysqlTable('auth_user', {
  id: int('id').primaryKey().notNull(),
  username: varchar('username', { length: 150 }).notNull(),
  firstName: varchar('first_name', { length: 30 }).notNull(),
  lastName: varchar('last_name', { length: 150 }).notNull(),
});
/** Current source binding only; a missing, cross-schema or mismatched actor FK fails closed. */
export const administrationHistoryActorForeignKey = mysqlSchema('information_schema').table(
  'KEY_COLUMN_USAGE',
  {
    tableSchema: varchar('TABLE_SCHEMA', { length: 64 }),
    tableName: varchar('TABLE_NAME', { length: 64 }),
    columnName: varchar('COLUMN_NAME', { length: 64 }),
    referencedSchema: varchar('REFERENCED_TABLE_SCHEMA', { length: 64 }),
    referencedTable: varchar('REFERENCED_TABLE_NAME', { length: 64 }),
    referencedColumn: varchar('REFERENCED_COLUMN_NAME', { length: 64 }),
  },
);
