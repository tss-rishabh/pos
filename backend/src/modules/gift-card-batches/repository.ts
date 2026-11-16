import { createHash, createHmac } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser } from '../../db/legacy-schema.js';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import type { Principal } from '../../domain/access.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { lockAdministrationRegistry } from '../administration/locks.js';
import { giftCardBatchJobs, giftCardBatchMutations, legacyGiftCardBatches } from './schema.js';
import type { GiftCardArchiveManifest, GiftCardBatchReceipt } from './contracts.js';

export type BatchTransaction = AdministrationTransaction;
export type LegacyGiftCardBatch = typeof legacyGiftCardBatches.$inferSelect;
export type PrivateGiftCardBatchJob = typeof giftCardBatchJobs.$inferSelect;
const {
  artifactBytes: _archive,
  sealedSecrets: _secrets,
  ...jobColumns
} = getTableColumns(giftCardBatchJobs);
export const giftCardBatchJobColumns = jobColumns;
export type GiftCardBatchJobMetadata = Omit<
  PrivateGiftCardBatchJob,
  'artifactBytes' | 'sealedSecrets'
>;
export const giftCardBatchInvalid = () =>
  new AppError(
    503,
    'GIFT_CARD_BATCH_DATA_INVALID',
    'Gift card batch data is temporarily unavailable.',
  );
export function giftCardBatchVersion(batch: LegacyGiftCardBatch) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        batch.id.toString(),
        batch.size,
        batch.message,
        batch.completed,
        batch.blocked,
        batch.printed,
        batch.filename,
        batch.createdBy.toString(),
        batch.createdAt,
      ]),
    )
    .digest('hex');
}
export function giftCardBatchJobVersion(batch: LegacyGiftCardBatch, job: GiftCardBatchJobMetadata) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        giftCardBatchVersion(batch),
        job.phase,
        job.updatedAt,
        job.artifactChecksum,
        job.artifactSize,
        job.errorCode,
        job.attempts,
        job.deliveryAttemptId,
        job.actorVersion,
      ]),
    )
    .digest('hex');
}
export function giftCardBatchManifest(job: GiftCardBatchJobMetadata): GiftCardArchiveManifest {
  if (!job.artifactChecksum || !job.artifactSize) throw giftCardBatchInvalid();
  return { key: job.artifactKey, checksum: job.artifactChecksum, size: job.artifactSize };
}
export function giftCardBatchRepository(
  config: Config,
  db: Databases,
  clock: () => Temporal.Instant = () => Temporal.Now.instant(),
) {
  const instant = () => clock(),
    utc = () =>
      instant()
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime()
        .toString({ smallestUnit: 'millisecond' })
        .replace('T', ' ');
  return {
    config,
    db,
    instant,
    utc,
    wall() {
      return instant()
        .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' ');
    },
    async actor(tx: BatchTransaction, id: string) {
      const [actor] = await tx
        .select()
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(id)))
        .limit(1)
        .for('share');
      if (!actor?.is_active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      if (actor.user_type !== 1 || ![1, 2].includes(actor.role))
        throw new AppError(
          403,
          'GIFT_CARD_BATCH_ACCESS_DENIED',
          'Gift card batches require current internal administration access.',
        );
      return { account: actor, version: await currentAuthenticationVersion(tx, actor) };
    },
    async lock(tx: BatchTransaction) {
      await lockAdministrationRegistry(tx, 'gift-card-batches');
    },
    async batch(tx: BatchTransaction, id: string, write = false) {
      const [row] = await tx
        .select()
        .from(legacyGiftCardBatches)
        .where(eq(legacyGiftCardBatches.id, BigInt(id)))
        .limit(1)
        .for(write ? 'update' : 'share');
      if (!row)
        throw new AppError(404, 'GIFT_CARD_BATCH_NOT_FOUND', 'Gift card batch was not found.');
      if (![row.completed, row.printed, row.blocked].every((value) => value === 0 || value === 1))
        throw giftCardBatchInvalid();
      return row;
    },
    async job(tx: BatchTransaction, id: string, write = false) {
      return (
        (
          await tx
            .select(jobColumns)
            .from(giftCardBatchJobs)
            .where(eq(giftCardBatchJobs.batchId, id))
            .limit(1)
            .for(write ? 'update' : 'share')
        )[0] || null
      );
    },
    async privateJob(tx: BatchTransaction, id: string, write = false) {
      return (
        (
          await tx
            .select()
            .from(giftCardBatchJobs)
            .where(eq(giftCardBatchJobs.batchId, id))
            .limit(1)
            .for(write ? 'update' : 'share')
        )[0] || null
      );
    },
    async secretJob(tx: BatchTransaction, id: string, write = false) {
      return (
        (
          await tx
            .select({
              ...jobColumns,
              sealedSecrets: giftCardBatchJobs.sealedSecrets,
              hasArtifactBytes:
                sql<boolean>`${giftCardBatchJobs.artifactBytes} IS NOT NULL`.mapWith(
                  (value: unknown) => value === true || String(value) === '1',
                ),
            })
            .from(giftCardBatchJobs)
            .where(eq(giftCardBatchJobs.batchId, id))
            .limit(1)
            .for(write ? 'update' : 'share')
        )[0] || null
      );
    },
    hash(value: unknown) {
      return createHmac('sha256', config.SESSION_SECRET)
        .update(JSON.stringify(value))
        .digest('hex');
    },
    async replay(
      tx: BatchTransaction,
      user: Principal,
      id: string,
      action: string,
      hash: string,
      batchId?: string,
    ) {
      const [row] = await tx
        .select()
        .from(giftCardBatchMutations)
        .where(eq(giftCardBatchMutations.id, id))
        .limit(1)
        .for('update');
      if (!row) return null;
      if (
        row.actorId !== user.id ||
        row.action !== action ||
        row.inputHash !== hash ||
        (batchId !== undefined && row.batchId !== batchId)
      )
        throw new AppError(
          409,
          'GIFT_CARD_BATCH_OPERATION_REUSED',
          'Choose a new gift card batch operation.',
        );
      return row.result;
    },
    async receipt(
      tx: BatchTransaction,
      user: Principal,
      id: string,
      action: string,
      hash: string,
      result: GiftCardBatchReceipt,
    ) {
      await tx.insert(giftCardBatchMutations).values({
        id,
        actorId: user.id,
        batchId: result.batchId,
        action,
        inputHash: hash,
        result,
        requestId: currentRequestTrace()?.requestId || null,
        createdAt: utc(),
      });
      return result;
    },
  };
}
export type GiftCardBatchRepository = ReturnType<typeof giftCardBatchRepository>;
