import { datetime, index, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

/** Short-lived proof/receipt metadata only. Never stores webhook, auth code, token or contacts. */
export const slackConnections = mysqlTable(
  'pos_rewrite_slack_connections',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    storeId: varchar('store_id', { length: 32 }).notNull(),
    stateHash: varchar('state_hash', { length: 64 }).notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    authenticationVersion: varchar('authentication_version', { length: 64 }).notNull(),
    sessionBinding: varchar('session_binding', { length: 64 }).notNull(),
    storeVersion: varchar('store_version', { length: 64 }).notNull(),
    configurationVersion: varchar('configuration_version', { length: 64 }).notNull(),
    requestId: varchar('request_id', { length: 36 }),
    errorCode: varchar('error_code', { length: 64 }),
    leaseToken: varchar('lease_token', { length: 36 }),
    channel: varchar('channel', { length: 255 }),
    channelId: varchar('channel_id', { length: 40 }),
    teamId: varchar('team_id', { length: 40 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
  },
  (table) => [
    uniqueIndex('uq_pos_rewrite_slack_state').on(table.stateHash),
    index('ix_pos_rewrite_slack_actor_store_state').on(table.actorId, table.storeId, table.state),
    index('ix_pos_rewrite_slack_expiry').on(table.expiresAt),
  ],
);
