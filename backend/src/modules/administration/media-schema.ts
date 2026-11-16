import {
  bigint,
  datetime,
  index,
  int,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

export const documentationAssets = mysqlTable(
  'pos_rewrite_documentation_assets',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    objectKey: varchar('object_key', { length: 1024 }).notNull(),
    objectDigest: varchar('object_digest', { length: 64 }).notNull(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    documentId: bigint('document_id', { mode: 'bigint', unsigned: true }),
    kind: varchar('kind', { length: 20 }).notNull(),
    source: varchar('source', { length: 8 }).notNull(),
    name: varchar('display_name', { length: 255 }).notNull(),
    contentType: varchar('content_type', { length: 128 }).notNull(),
    size: int('size').notNull(),
    checksum: varchar('checksum_sha256', { length: 44 }),
    state: varchar('state', { length: 20 }).notNull(),
    attempts: int('attempts').notNull(),
    expiresAt: datetime('expires_at', { mode: 'string', fsp: 3 }).notNull(),
    createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_documentation_object_digest').on(table.objectDigest),
    index('ix_documentation_cleanup').on(table.state, table.expiresAt, table.attempts),
    index('ix_documentation_assets_document').on(table.documentId, table.state),
    index('ix_documentation_blocked').on(table.state, table.id),
  ],
);
export const documentationRevisions = mysqlTable('pos_rewrite_documentation_revisions', {
  documentId: bigint('document_id', { mode: 'bigint', unsigned: true }).primaryKey(),
  version: int('version').notNull(),
  requestId: varchar('request_id', { length: 128 }),
});
export const documentationMutations = mysqlTable('pos_rewrite_documentation_mutations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  actorId: varchar('actor_id', { length: 32 }).notNull(),
  requestId: varchar('request_id', { length: 128 }),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  documentId: bigint('document_id', { mode: 'bigint', unsigned: true }).notNull(),
  version: int('version').notNull(),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
});
