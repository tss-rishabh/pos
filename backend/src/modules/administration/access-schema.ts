import {
  bigint,
  boolean,
  datetime,
  json,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';

/** Stable keys survive independent legacy content-type/permission primary keys. */
export const administrationPermissions = mysqlTable('pos_rewrite_administration_permissions', {
  key: varchar('permission_key', { length: 201 }).primaryKey(),
  appLabel: varchar('app_label', { length: 100 }).notNull(),
  model: varchar('model', { length: 100 }).notNull(),
  codename: varchar('codename', { length: 100 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
});
export const administrationGroups = mysqlTable('pos_rewrite_administration_groups', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 150 }).notNull(),
  revision: bigint('revision', { mode: 'bigint', unsigned: true }).notNull().default(1n),
  legacyId: varchar('legacy_id', { length: 32 }),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
});
export const administrationGroupPermissions = mysqlTable(
  'pos_rewrite_administration_group_permissions',
  {
    groupId: varchar('group_id', { length: 36 }).notNull(),
    permissionKey: varchar('permission_key', { length: 201 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.permissionKey] })],
);
export const administrationMemberships = mysqlTable(
  'pos_rewrite_administration_memberships',
  {
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    groupId: varchar('group_id', { length: 36 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.operatorId, table.groupId] })],
);
export const administrationDirectPermissions = mysqlTable(
  'pos_rewrite_administration_direct_permissions',
  {
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    permissionKey: varchar('permission_key', { length: 201 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.operatorId, table.permissionKey] })],
);
export const administrationAccessReconciliation = mysqlTable(
  'pos_rewrite_administration_access_reconciliation',
  {
    id: varchar('id', { length: 16 }).primaryKey(),
    verified: boolean('verified').notNull(),
    sourceFingerprint: varchar('source_fingerprint', { length: 64 }).notNull(),
    snapshotHash: varchar('snapshot_hash', { length: 64 }).notNull(),
    operatorId: varchar('operator_id', { length: 32 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    counts: json('counts')
      .$type<{
        permissions: number;
        groups: number;
        operators: number;
        memberships: number;
        groupPermissions: number;
        directPermissions: number;
      }>()
      .notNull(),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }).notNull(),
  },
);
export const administrationAccessMutations = mysqlTable(
  'pos_rewrite_administration_access_mutations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    resourceId: varchar('resource_id', { length: 64 }).notNull(),
    action: varchar('action', { length: 32 }).notNull(),
    hash: varchar('hash', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    result: json('result')
      .$type<{
        status: 'success';
        id: string;
        message: string;
        credentialsChanged?: boolean;
        reauthenticate?: boolean;
        deletedGroupIds?: string[];
      }>()
      .notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
);
