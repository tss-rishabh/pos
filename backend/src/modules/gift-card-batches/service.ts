import { Temporal } from '@js-temporal/polyfill';
import { and, desc, eq, getTableColumns, gte, inArray, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { generatedId } from '../../db/generated-id.js';
import { PosUser, PosSpecialPermissionActivityLog } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import {
  createGiftCardBatchInput,
  printGiftCardBatchInput,
  blockGiftCardBatchInput,
  retryGiftCardBatchInput,
  type GiftCardBatchStorage,
  type GiftCardBatchDelivery,
} from './contracts.js';
import { readGiftCardBatchOptions, type GiftCardBatchOptions } from './options.js';
import {
  giftCardBatchRepository,
  giftCardBatchVersion,
  giftCardBatchJobVersion,
  giftCardBatchManifest,
  giftCardBatchJobColumns,
  giftCardBatchInvalid,
  type LegacyGiftCardBatch,
  type GiftCardBatchJobMetadata,
  type BatchTransaction,
} from './repository.js';
import { giftCardBatchJobs, legacyGiftCardBatches } from './schema.js';
import { giftCardRecipient } from './generation.js';
import {
  newGiftCardSecrets,
  openGiftCardSecrets,
  sealGiftCardSecrets,
  giftCardFormatFingerprint,
} from './secrets.js';
import { createGiftCardBatchStorage } from './storage.js';
import { createGiftCardBatchDelivery } from './delivery.js';
import { sourceAdministrationFullName } from '../administration-history/messages.js';

export interface GiftCardBatchDependencies {
  storage?: GiftCardBatchStorage | null;
  delivery?: GiftCardBatchDelivery | null;
  clock?: () => Temporal.Instant;
}
const unavailable = () =>
  new AppError(
    503,
    'GIFT_CARD_BATCH_GENERATION_UNAVAILABLE',
    'Gift card generation requires configured private storage, archive keys and delivery.',
  );
const conflict = () =>
  new AppError(
    409,
    'GIFT_CARD_BATCH_CHANGED',
    'This batch changed. Reload before confirming again.',
  );
export function giftCardBatchService(
  config: Config,
  db: Databases,
  options: GiftCardBatchOptions = readGiftCardBatchOptions(),
  dependencies: GiftCardBatchDependencies = {},
) {
  const repository = giftCardBatchRepository(config, db, dependencies.clock),
    storage =
      dependencies.storage === undefined
        ? createGiftCardBatchStorage(config, options)
        : dependencies.storage,
    delivery =
      dependencies.delivery === undefined
        ? createGiftCardBatchDelivery(config, options)
        : dependencies.delivery;
  const configured = () =>
    Boolean(
      options.GIFT_CARD_BATCHES_ENABLED &&
      options.GC_SALTKEY &&
      options.GIFT_CARD_BATCH_ACTIVE_KEY_ID &&
      options.GIFT_CARD_BATCH_ENCRYPTION_KEYS &&
      Object.hasOwn(
        options.GIFT_CARD_BATCH_ENCRYPTION_KEYS,
        options.GIFT_CARD_BATCH_ACTIVE_KEY_ID,
      ) &&
      storage &&
      delivery,
    );
  function owner(
    user: Principal,
    batch: LegacyGiftCardBatch,
    job: GiftCardBatchJobMetadata | null,
  ) {
    if (
      !job ||
      job.actorId !== user.id ||
      batch.createdBy.toString() !== user.id ||
      job.batchId !== batch.id.toString()
    )
      throw new AppError(
        403,
        'GIFT_CARD_BATCH_ARTIFACT_DENIED',
        'Only the current batch owner can retrieve its private file.',
      );
    if (
      batch.completed !== 1 ||
      batch.filename !== job.artifactKey ||
      !job.artifactChecksum ||
      !job.artifactSize ||
      !storage
    )
      throw new AppError(
        409,
        'GIFT_CARD_BATCH_ARTIFACT_NOT_READY',
        'The private file is not ready yet.',
      );
    return job;
  }
  async function publicBatch(
    tx: BatchTransaction,
    user: Principal,
    batch: LegacyGiftCardBatch,
    job: GiftCardBatchJobMetadata | null,
    knownCreator?: { first: string | null; last: string | null },
  ) {
    if (
      ![batch.completed, batch.printed, batch.blocked].every((flag) => flag === 0 || flag === 1) ||
      (job && job.batchId !== batch.id.toString())
    )
      throw giftCardBatchInvalid();
    const creator =
      knownCreator ||
      (
        await tx
          .select({ first: PosUser.first_name, last: PosUser.last_name })
          .from(PosUser)
          .where(eq(PosUser.id, batch.createdBy))
          .limit(1)
      )[0];
    return {
      id: batch.id.toString(),
      size: batch.size,
      message: batch.message,
      completed: batch.completed === 1,
      blocked: batch.blocked === 1,
      printed: batch.printed === 1,
      createdById: batch.createdBy.toString(),
      createdByName: creator ? sourceAdministrationFullName(creator.first, creator.last) : '',
      createdAt: batch.createdAt,
      version: giftCardBatchVersion(batch),
      artifactAvailable: Boolean(
        job &&
        job.actorId === user.id &&
        batch.createdBy.toString() === user.id &&
        batch.completed === 1 &&
        batch.filename === job.artifactKey &&
        job.artifactChecksum &&
        job.artifactSize &&
        storage,
      ),
      job: job
        ? {
            phase: job.phase,
            errorCode: job.errorCode,
            updatedAt: job.updatedAt,
            version: giftCardBatchJobVersion(batch, job),
            canRetry:
              job.actorId === user.id &&
              !['QUEUED', 'GENERATED', 'STORED', 'SENDING'].includes(job.phase),
          }
        : null,
    };
  }
  const service = {
    repository,
    storage: storage || undefined,
    delivery: delivery || undefined,
    options,
    async capabilities(user: Principal) {
      return db.get('writer').transaction(async (tx) => {
        const actor = await repository.actor(tx, user.id);
        let recipient: string | null = null;
        try {
          recipient = giftCardRecipient(actor.account.email);
        } catch {
          /* Missing delivery contact does not hide existing batch controls. */
        }
        return {
          today: repository
            .instant()
            .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
            .toPlainDate()
            .toString(),
          timeZone: config.BUSINESS_TIMEZONE,
          generationAvailable: configured() && recipient !== null,
          recipient,
          historyAvailable: Boolean(
            options.BQ_GIFT_CARD_BATCH_VIEW &&
            options.BQ_GIFT_CARD_BATCH_MATCH_UDF &&
            options.BQ_GIFT_CARD_BATCH_CONTRACT,
          ),
          maxSize: 10000,
        };
      });
    },
    async create(user: Principal, raw: z.infer<typeof createGiftCardBatchInput>) {
      const input = createGiftCardBatchInput.parse(raw),
        hash = repository.hash(input);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await repository.lock(tx);
          const actor = await repository.actor(tx, user.id);
          const previous = await repository.replay(tx, user, input.operationId, 'create', hash);
          if (previous) return previous;
          if (!configured() || !storage) throw unavailable();
          const recipient = giftCardRecipient(actor.account.email);
          const [encoding] = await tx
            .select({
              valid:
                sql<boolean>`CAST(CONVERT(CONVERT(${input.message} USING latin1) USING utf8mb4) AS BINARY)=CAST(${input.message} AS BINARY)`.mapWith(
                  (value: unknown) => value === true || String(value) === '1',
                ),
            })
            .from(PosUser)
            .where(eq(PosUser.id, actor.account.id))
            .limit(1);
          if (!encoding?.valid)
            throw new AppError(
              400,
              'GIFT_CARD_BATCH_MESSAGE_ENCODING',
              'Use characters supported by the batch message field.',
            );
          const batchId = generatedId(
            await tx.insert(legacyGiftCardBatches).values({
              size: input.size,
              message: input.message,
              completed: 0,
              blocked: 0,
              printed: 0,
              filename: '',
              createdBy: actor.account.id,
              createdAt: repository.wall(),
            }),
          ).toString();
          if (batchId.length > 9)
            throw new AppError(
              503,
              'GIFT_CARD_BATCH_FORMAT_UNSUPPORTED',
              'This batch cannot use the verified gift card format.',
            );
          const now = repository.utc();
          await tx.insert(giftCardBatchJobs).values({
            id: input.operationId,
            batchId,
            actorId: user.id,
            actorVersion: actor.version,
            requestedSize: input.size,
            sealedSecrets: newGiftCardSecrets(options, batchId, recipient),
            phase: 'QUEUED',
            artifactKey: storage.keyFor(input.operationId),
            attempts: 0,
            requestId: currentRequestTrace()?.requestId || null,
            createdAt: now,
            updatedAt: now,
          });
          return repository.receipt(tx, user, input.operationId, 'create', hash, {
            id: input.operationId,
            batchId,
            status: 'success',
            message: 'Gift card generation queued.',
          });
        }),
      );
    },
    async details(user: Principal, id: string) {
      return db.get('writer').transaction(async (tx) => {
        await repository.actor(tx, user.id);
        const batch = await repository.batch(tx, id),
          job = await repository.job(tx, id);
        return publicBatch(tx, user, batch, job);
      });
    },
    async currentJobs(user: Principal) {
      return db.get('writer').transaction(async (tx) => {
        const actor = await repository.actor(tx, user.id),
          cutoff = repository
            .instant()
            .subtract({ hours: 24 })
            .toZonedDateTimeISO('UTC')
            .toPlainDateTime()
            .toString({ smallestUnit: 'millisecond' })
            .replace('T', ' ');
        const records = await tx
          .select({ batch: getTableColumns(legacyGiftCardBatches), job: giftCardBatchJobColumns })
          .from(giftCardBatchJobs)
          .innerJoin(
            legacyGiftCardBatches,
            eq(legacyGiftCardBatches.id, sql`CAST(${giftCardBatchJobs.batchId} AS SIGNED)`),
          )
          .where(
            and(
              eq(giftCardBatchJobs.actorId, user.id),
              eq(legacyGiftCardBatches.createdBy, BigInt(user.id)),
              or(
                inArray(giftCardBatchJobs.phase, [
                  'QUEUED',
                  'GENERATED',
                  'STORED',
                  'SENDING',
                  'BLOCKED',
                  'UNCERTAIN',
                  'FAILED',
                ]),
                gte(giftCardBatchJobs.createdAt, cutoff),
              ),
            ),
          )
          .orderBy(desc(giftCardBatchJobs.createdAt), desc(giftCardBatchJobs.id))
          .limit(25);
        return {
          data: await Promise.all(
            records.map((row) =>
              publicBatch(tx, user, row.batch, row.job, {
                first: actor.account.first_name,
                last: actor.account.last_name,
              }),
            ),
          ),
        };
      });
    },
    async recordView(user: Principal, operationId: string) {
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await repository.lock(tx);
          await repository.actor(tx, user.id);
          const hash = repository.hash({ kind: 'gift-card-batch-list-view' });
          if (await repository.replay(tx, user, operationId, 'view', hash, '0')) return;
          const wall = repository.wall();
          await tx.insert(PosSpecialPermissionActivityLog).values({
            pos_user_id: BigInt(user.id),
            platform: 'Gift Card',
            comment: 'Viewed the gift card batch list',
            recipient: null,
            created_at: wall,
            updated_at: wall,
          });
          await repository.receipt(tx, user, operationId, 'view', hash, {
            id: operationId,
            batchId: '0',
            status: 'success',
            message: 'Batch list viewed.',
          });
        }),
      );
    },
    async markPrinted(user: Principal, id: string, raw: z.infer<typeof printGiftCardBatchInput>) {
      const input = printGiftCardBatchInput.parse(raw),
        hash = repository.hash({ id, input });
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await repository.lock(tx);
          await repository.actor(tx, user.id);
          const previous = await repository.replay(
            tx,
            user,
            input.operationId,
            'printed',
            hash,
            id,
          );
          if (previous) return previous;
          const batch = await repository.batch(tx, id, true);
          if (giftCardBatchVersion(batch) !== input.expectedVersion) throw conflict();
          if (batch.completed !== 1)
            throw new AppError(
              409,
              'GIFT_CARD_BATCH_INCOMPLETE',
              'Finish generating this batch before marking it printed.',
            );
          await tx
            .update(legacyGiftCardBatches)
            .set({ printed: 1 })
            .where(eq(legacyGiftCardBatches.id, BigInt(id)));
          return repository.receipt(tx, user, input.operationId, 'printed', hash, {
            id: input.operationId,
            batchId: id,
            status: 'success',
            message: 'Marked as printed',
          });
        }),
      );
    },
    async setBlocked(user: Principal, id: string, raw: z.infer<typeof blockGiftCardBatchInput>) {
      const input = blockGiftCardBatchInput.parse(raw),
        hash = repository.hash({ id, input });
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await repository.lock(tx);
          await repository.actor(tx, user.id);
          const previous = await repository.replay(
            tx,
            user,
            input.operationId,
            'blocked',
            hash,
            id,
          );
          if (previous) return previous;
          const batch = await repository.batch(tx, id, true);
          if (giftCardBatchVersion(batch) !== input.expectedVersion) throw conflict();
          await tx
            .update(legacyGiftCardBatches)
            .set({ blocked: input.blocked ? 1 : 0 })
            .where(eq(legacyGiftCardBatches.id, BigInt(id)));
          return repository.receipt(tx, user, input.operationId, 'blocked', hash, {
            id: input.operationId,
            batchId: id,
            status: 'success',
            message: input.blocked ? 'Marked as block' : 'Marked as active',
          });
        }),
      );
    },
    async retry(user: Principal, id: string, raw: z.infer<typeof retryGiftCardBatchInput>) {
      const input = retryGiftCardBatchInput.parse(raw),
        hash = repository.hash({ id, input });
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await repository.lock(tx);
          const actor = await repository.actor(tx, user.id);
          const previous = await repository.replay(tx, user, input.operationId, 'retry', hash, id);
          if (previous) return previous;
          if (!configured()) throw unavailable();
          const batch = await repository.batch(tx, id, true),
            job = await repository.secretJob(tx, id, true);
          if (!job || job.actorId !== user.id || batch.createdBy.toString() !== user.id)
            throw new AppError(
              403,
              'GIFT_CARD_BATCH_RETRY_DENIED',
              'Only the batch owner can retry delivery.',
            );
          if (giftCardBatchJobVersion(batch, job) !== input.expectedVersion) throw conflict();
          if (job.leaseExpiresAt && job.leaseExpiresAt > repository.utc())
            throw new AppError(409, 'GIFT_CARD_BATCH_BUSY', 'This batch is being processed.');
          if (
            ['UNCERTAIN', 'DELIVERED'].includes(job.phase) &&
            (batch.completed !== 1 ||
              batch.filename !== job.artifactKey ||
              !job.artifactChecksum ||
              !job.artifactSize)
          )
            throw new AppError(
              409,
              'GIFT_CARD_BATCH_ARCHIVE_INVALID',
              'Reconcile the original archive before any delivery retry.',
            );
          if (!['BLOCKED', 'FAILED', 'UNCERTAIN', 'DELIVERED'].includes(job.phase))
            throw new AppError(409, 'GIFT_CARD_BATCH_BUSY', 'This batch is already queued.');
          if (['UNCERTAIN', 'DELIVERED'].includes(job.phase) && !input.confirmResend)
            throw new AppError(
              409,
              'GIFT_CARD_BATCH_RESEND_CONFIRMATION',
              'Confirm sending the same encrypted file again.',
            );
          const secrets = openGiftCardSecrets(options, id, job.sealedSecrets);
          if (
            !options.GC_SALTKEY ||
            secrets.formatFingerprint !== giftCardFormatFingerprint(options.GC_SALTKEY) ||
            batch.size !== job.requestedSize
          )
            throw new AppError(
              409,
              'GIFT_CARD_BATCH_FORMAT_CHANGED',
              'Reconcile the original batch format before retrying.',
            );
          await tx
            .update(giftCardBatchJobs)
            .set({
              actorVersion: actor.version,
              sealedSecrets: sealGiftCardSecrets(options, {
                ...secrets,
                recipient: giftCardRecipient(actor.account.email),
              }),
              phase:
                job.artifactChecksum && batch.completed === 1
                  ? 'STORED'
                  : job.hasArtifactBytes
                    ? 'GENERATED'
                    : 'QUEUED',
              attempts: 0,
              errorCode: null,
              leaseToken: null,
              leaseExpiresAt: null,
              deliveryAttemptId: null,
              updatedAt: repository.utc(),
            })
            .where(eq(giftCardBatchJobs.id, job.id));
          return repository.receipt(tx, user, input.operationId, 'retry', hash, {
            id: input.operationId,
            batchId: id,
            status: 'success',
            message: 'The same gift card batch is queued for delivery.',
          });
        }),
      );
    },
    async artifactAccess(user: Principal, id: string) {
      return db.get('writer').transaction(async (tx) => {
        await repository.actor(tx, user.id);
        const batch = await repository.batch(tx, id),
          job = await repository.secretJob(tx, id);
        owner(user, batch, job);
        const secret = openGiftCardSecrets(options, id, job!.sealedSecrets);
        return { filename: `gift-cards-${id}.zip`, password: secret.password };
      });
    },
    async archive(user: Principal, id: string, signal?: AbortSignal) {
      const manifest = await db.get('writer').transaction(async (tx) => {
        await repository.actor(tx, user.id);
        const batch = await repository.batch(tx, id),
          job = owner(user, batch, await repository.job(tx, id));
        return giftCardBatchManifest(job);
      });
      if (!storage) throw unavailable();
      const bytes = await storage.get(manifest, signal);
      await db.get('writer').transaction(async (tx) => {
        await repository.actor(tx, user.id);
        const current = giftCardBatchManifest(
          owner(user, await repository.batch(tx, id), await repository.job(tx, id)),
        );
        if (
          current.key !== manifest.key ||
          current.checksum !== manifest.checksum ||
          current.size !== manifest.size
        )
          throw conflict();
      });
      return bytes;
    },
    close() {
      storage?.close();
    },
  };
  return service;
}
export type GiftCardBatchService = ReturnType<typeof giftCardBatchService>;
