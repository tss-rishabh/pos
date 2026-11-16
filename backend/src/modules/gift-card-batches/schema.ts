import {
  bigint,
  customType,
  datetime,
  index,
  int,
  json,
  mysqlTable,
  tinyint,
  uniqueIndex,
  varchar,
  text,
} from 'drizzle-orm/mysql-core';
import type { GiftCardBatchPhase, GiftCardBatchReceipt } from './contracts.js';

const encryptedArchive = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'mediumblob',
});
/** Verified mysql-gift-card-batches-schema.json; read/write projection only, never migrated. */
export const legacyGiftCardBatches = mysqlTable('gift_card_collection', {
  id: bigint('id', { mode: 'bigint' }).autoincrement().primaryKey().notNull(),
  size: int('size').notNull(),
  completed: tinyint('is_completed').notNull(),
  blocked: tinyint('is_block').notNull(),
  printed: tinyint('is_printed').notNull(),
  filename: varchar('filename', { length: 255 }),
  message: varchar('message', { length: 255 }),
  createdBy: bigint('created_by', { mode: 'bigint' }).notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
/** Rewrite-only generation/delivery state; no gift_vouchers or financial balances are created. */
export const giftCardBatchJobs = mysqlTable(
  'pos_rewrite_gift_card_batch_jobs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    batchId: varchar('batch_id', { length: 32 }).notNull(),
    actorId: varchar('actor_id', { length: 32 }).notNull(),
    actorVersion: varchar('actor_version', { length: 64 }).notNull(),
    requestedSize: int('requested_size').notNull(),
    sealedSecrets: text('sealed_secrets').notNull(),
    phase: varchar('phase', { length: 24 }).$type<GiftCardBatchPhase>().notNull(),
    artifactBytes: encryptedArchive('artifact_bytes'),
    artifactKey: varchar('artifact_key', { length: 255 }).notNull(),
    artifactChecksum: varchar('artifact_checksum', { length: 64 }),
    artifactSize: int('artifact_size'),
    attempts: int('attempts').notNull(),
    errorCode: varchar('error_code', { length: 64 }),
    leaseToken: varchar('lease_token', { length: 36 }),
    leaseExpiresAt: datetime('lease_expires_at', { mode: 'string', fsp: 3 }),
    deliveryAttemptId: varchar('delivery_attempt_id', { length: 36 }),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'string', fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_gift_card_batch_job_batch').on(table.batchId),
    index('ix_gift_card_batch_job_pending').on(table.phase, table.leaseExpiresAt, table.createdAt),
    index('ix_gift_card_batch_job_actor').on(table.actorId, table.createdAt),
  ],
);
export const giftCardBatchMutations = mysqlTable('pos_rewrite_gift_card_batch_mutations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  actorId: varchar('actor_id', { length: 32 }).notNull(),
  batchId: varchar('batch_id', { length: 32 }).notNull(),
  action: varchar('action', { length: 24 }).notNull(),
  inputHash: varchar('input_hash', { length: 64 }).notNull(),
  result: json('result').$type<GiftCardBatchReceipt>().notNull(),
  requestId: varchar('request_id', { length: 128 }),
  createdAt: datetime('created_at', { mode: 'string', fsp: 3 }).notNull(),
});
