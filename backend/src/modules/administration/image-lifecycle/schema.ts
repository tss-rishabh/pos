import { datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export function imageUploadTable<Name extends string>(
  name: Name,
  revisionColumn: string,
  ownerLength = 32,
) {
  return mysqlTable(name, {
    id: varchar('id', { length: 36 }).primaryKey(),
    ownerId: varchar('owner_id', { length: ownerLength }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(),
    objectKey: varchar('object_key', { length: 254 }).notNull(),
    contentType: varchar('content_type', { length: 64 }).notNull(),
    size: int('size').notNull(),
    checksum: varchar('checksum', { length: 44 }).notNull(),
    ownerRevision: varchar(revisionColumn, { length: 64 }).notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    attachedAt: datetime('attached_at', { mode: 'date', fsp: 3 }),
  });
}
export function imageCleanupTable<Name extends string>(name: Name) {
  return mysqlTable(name, {
    id: varchar('id', { length: 36 }).primaryKey(),
    uploadId: varchar('upload_id', { length: 36 }).notNull(),
    ownerId: varchar('owner_id', { length: 32 }).notNull(),
    requestId: varchar('request_id', { length: 36 }),
    state: varchar('state', { length: 16 }).notNull(),
    attempts: int('attempts').notNull(),
    availableAt: datetime('available_at', { mode: 'date', fsp: 3 }).notNull(),
    leaseToken: varchar('lease_token', { length: 36 }),
    leaseUntil: datetime('lease_until', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  });
}
export interface ImageTables {
  uploads: ReturnType<typeof imageUploadTable<string>>;
  jobs: ReturnType<typeof imageCleanupTable<string>>;
}
export type ImageUpload = ImageTables['uploads']['$inferSelect'];
