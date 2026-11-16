import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { AppError } from '../../domain/errors.js';
import { retryTransaction } from '../../db/retry.js';
import { giftCardArchive } from './archives.js';
import { generateGiftCards, giftCardCsv, giftCardRecipient } from './generation.js';
import { giftCardBatchJobs, legacyGiftCardBatches } from './schema.js';
import { giftCardBatchManifest, type PrivateGiftCardBatchJob } from './repository.js';
import { giftCardFormatFingerprint, openGiftCardSecrets } from './secrets.js';
import type { GiftCardBatchService } from './service.js';
import type { GiftCardBatchPhase } from './contracts.js';

const pendingPhases = ['QUEUED', 'GENERATED', 'STORED', 'SENDING'] as const;
export interface GiftCardBatchWorkerEvent {
  module: 'gift-card-batches';
  resource: 'generation-worker';
  eventId: string;
  eventInstanceId: string;
  requestId: string | null;
  userId: string | null;
  batchId?: string;
  jobId?: string;
  errorCode?: string;
}
export type GiftCardBatchWorkerLogger = (
  level: 'info' | 'warn',
  event: GiftCardBatchWorkerEvent,
  message: string,
) => void;

/** The lease fences every database transition; external I/O always runs outside SQL transactions. */
export function giftCardBatchWorker(
  service: GiftCardBatchService,
  log: GiftCardBatchWorkerLogger = () => undefined,
) {
  const { repository, options, storage, delivery } = service;
  const writer = repository.db.get('writer');
  const available = Boolean(
    options.GIFT_CARD_BATCHES_ENABLED &&
    options.GIFT_CARD_BATCH_WORKER_ENABLED &&
    options.GC_SALTKEY &&
    options.GIFT_CARD_BATCH_ACTIVE_KEY_ID &&
    options.GIFT_CARD_BATCH_ENCRYPTION_KEYS &&
    Object.hasOwn(options.GIFT_CARD_BATCH_ENCRYPTION_KEYS, options.GIFT_CARD_BATCH_ACTIVE_KEY_ID) &&
    storage &&
    delivery,
  );
  if (
    available &&
    options.GIFT_CARD_BATCH_WORKER_LEASE_MS <= options.GIFT_CARD_BATCH_WORKER_TIMEOUT_MS + 5000
  )
    throw new AppError(
      503,
      'GIFT_CARD_BATCH_LEASE_INVALID',
      'Configure a gift card worker lease longer than its operation timeout.',
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<boolean> | undefined;
  let stopping = false;
  const controller = new AbortController();
  const future = (milliseconds: number) =>
    repository
      .instant()
      .add({ milliseconds })
      .toZonedDateTimeISO('UTC')
      .toPlainDateTime()
      .toString({ smallestUnit: 'millisecond' })
      .replace('T', ' ');
  const event = (action: string, job?: PrivateGiftCardBatchJob, errorCode?: string) => ({
    module: 'gift-card-batches' as const,
    resource: 'generation-worker' as const,
    eventId: `gift-card-batches.generation-worker.${action}`,
    eventInstanceId: randomUUID(),
    requestId: job?.requestId || null,
    userId: job?.actorId || null,
    ...(job ? { batchId: job.batchId, jobId: job.id } : {}),
    ...(errorCode ? { errorCode } : {}),
  });
  async function withClaim<T>(
    job: PrivateGiftCardBatchJob,
    action: (
      tx: Parameters<Parameters<typeof writer.transaction>[0]>[0],
      current: PrivateGiftCardBatchJob,
    ) => Promise<T>,
  ): Promise<T | null> {
    return retryTransaction(() =>
      writer.transaction(async (tx) => {
        let actor: Awaited<ReturnType<typeof repository.actor>> | undefined;
        try {
          actor = await repository.actor(tx, job.actorId);
        } catch (error) {
          if (!(error instanceof AppError) || ![401, 403].includes(error.status)) throw error;
        }
        const batch = await repository.batch(tx, job.batchId, true);
        const current = await repository.privateJob(tx, job.batchId, true);
        if (
          !current ||
          current.leaseToken !== job.leaseToken ||
          !current.leaseExpiresAt ||
          current.leaseExpiresAt <= repository.utc()
        )
          return null;
        let contactMatches = false;
        try {
          const secrets = openGiftCardSecrets(options, job.batchId, current.sealedSecrets);
          contactMatches = Boolean(
            actor &&
            giftCardRecipient(actor.account.email) === secrets.recipient &&
            options.GC_SALTKEY &&
            secrets.formatFingerprint === giftCardFormatFingerprint(options.GC_SALTKEY),
          );
        } catch {
          /* An unavailable key or changed contact blocks new external work. */
        }
        if (
          !actor ||
          actor.version !== current.actorVersion ||
          !contactMatches ||
          batch.createdBy.toString() !== current.actorId ||
          batch.size !== current.requestedSize
        ) {
          await tx
            .update(giftCardBatchJobs)
            .set({
              phase: current.phase === 'SENDING' ? 'UNCERTAIN' : 'BLOCKED',
              errorCode: 'GIFT_CARD_BATCH_OWNER_CHANGED',
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: repository.utc(),
            })
            .where(eq(giftCardBatchJobs.id, current.id));
          return null;
        }
        return action(tx, current);
      }),
    );
  }
  async function claim(): Promise<PrivateGiftCardBatchJob | null> {
    const candidates = await writer
      .select({
        id: giftCardBatchJobs.id,
        batchId: giftCardBatchJobs.batchId,
        actorId: giftCardBatchJobs.actorId,
      })
      .from(giftCardBatchJobs)
      .where(
        and(
          inArray(giftCardBatchJobs.phase, [...pendingPhases]),
          or(
            isNull(giftCardBatchJobs.leaseExpiresAt),
            lte(giftCardBatchJobs.leaseExpiresAt, repository.utc()),
          ),
        ),
      )
      .orderBy(asc(giftCardBatchJobs.createdAt), asc(giftCardBatchJobs.id))
      .limit(25);
    for (const candidate of candidates) {
      const claimed = await retryTransaction(() =>
        writer.transaction(async (tx) => {
          let actor: Awaited<ReturnType<typeof repository.actor>> | undefined;
          try {
            actor = await repository.actor(tx, candidate.actorId);
          } catch (error) {
            if (!(error instanceof AppError) || ![401, 403].includes(error.status)) throw error;
          }
          const batch = await repository.batch(tx, candidate.batchId, true);
          const job = await repository.privateJob(tx, candidate.batchId, true);
          if (
            !job ||
            !pendingPhases.includes(job.phase as (typeof pendingPhases)[number]) ||
            (job.leaseExpiresAt && job.leaseExpiresAt > repository.utc())
          )
            return null;
          if (job.phase === 'SENDING') {
            await tx
              .update(giftCardBatchJobs)
              .set({
                phase: 'UNCERTAIN',
                errorCode: 'GIFT_CARD_BATCH_DELIVERY_UNCERTAIN',
                leaseToken: null,
                leaseExpiresAt: null,
                updatedAt: repository.utc(),
              })
              .where(eq(giftCardBatchJobs.id, job.id));
            log(
              'warn',
              event('delivery-uncertain', job, 'GIFT_CARD_BATCH_DELIVERY_UNCERTAIN'),
              'Gift card delivery needs owner reconciliation',
            );
            return null;
          }
          let contactMatches = false;
          try {
            const secrets = openGiftCardSecrets(options, job.batchId, job.sealedSecrets);
            contactMatches = Boolean(
              actor &&
              giftCardRecipient(actor.account.email) === secrets.recipient &&
              options.GC_SALTKEY &&
              secrets.formatFingerprint === giftCardFormatFingerprint(options.GC_SALTKEY),
            );
          } catch {
            /* Do not publish unverified or differently encoded cards. */
          }
          const errorCode =
            !actor ||
            actor.version !== job.actorVersion ||
            !contactMatches ||
            batch.createdBy.toString() !== job.actorId ||
            batch.size !== job.requestedSize
              ? 'GIFT_CARD_BATCH_OWNER_CHANGED'
              : job.attempts >= 5
                ? 'GIFT_CARD_BATCH_RETRY_LIMIT'
                : null;
          if (errorCode) {
            await tx
              .update(giftCardBatchJobs)
              .set({
                phase: errorCode === 'GIFT_CARD_BATCH_RETRY_LIMIT' ? 'FAILED' : 'BLOCKED',
                errorCode,
                leaseToken: null,
                leaseExpiresAt: null,
                updatedAt: repository.utc(),
              })
              .where(eq(giftCardBatchJobs.id, job.id));
            return null;
          }
          const leaseToken = randomUUID(),
            leaseExpiresAt = future(options.GIFT_CARD_BATCH_WORKER_LEASE_MS);
          await tx
            .update(giftCardBatchJobs)
            .set({
              leaseToken,
              leaseExpiresAt,
              attempts: job.attempts + 1,
              errorCode: null,
              updatedAt: repository.utc(),
            })
            .where(eq(giftCardBatchJobs.id, job.id));
          return { ...job, leaseToken, leaseExpiresAt, attempts: job.attempts + 1 };
        }),
      );
      if (claimed) return claimed;
    }
    return null;
  }
  async function perform(): Promise<boolean> {
    if (!available || !storage || !delivery || !options.GC_SALTKEY || stopping) return false;
    const job = await claim();
    if (!job) return false;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(options.GIFT_CARD_BATCH_WORKER_TIMEOUT_MS),
    ]);
    let stage: GiftCardBatchPhase = job.phase;
    try {
      const secret = openGiftCardSecrets(options, job.batchId, job.sealedSecrets);
      if (stage === 'QUEUED') {
        const csv = giftCardCsv(
          generateGiftCards(job.batchId, job.requestedSize, options.GC_SALTKEY),
        );
        const bytes = await giftCardArchive(csv, secret.password, signal);
        signal.throwIfAborted();
        const checksum = createHash('sha256').update(bytes).digest('hex');
        const frozen = await withClaim(job, async (tx, current) => {
          if (current.phase !== 'QUEUED') return false;
          await tx
            .update(giftCardBatchJobs)
            .set({
              phase: 'GENERATED',
              artifactBytes: bytes,
              artifactChecksum: checksum,
              artifactSize: bytes.length,
              updatedAt: repository.utc(),
            })
            .where(eq(giftCardBatchJobs.id, current.id));
          return true;
        });
        if (!frozen) return true;
        job.artifactBytes = bytes;
        job.artifactChecksum = checksum;
        job.artifactSize = bytes.length;
        stage = 'GENERATED';
      }
      if (stage === 'GENERATED') {
        const manifest = giftCardBatchManifest(job);
        if (
          !job.artifactBytes ||
          job.artifactBytes.length !== manifest.size ||
          createHash('sha256').update(job.artifactBytes).digest('hex') !== manifest.checksum
        )
          throw new AppError(
            503,
            'GIFT_CARD_BATCH_ARCHIVE_INVALID',
            'Gift card archive needs reconciliation.',
          );
        // Check the owner immediately before starting a new external operation.
        if (!(await withClaim(job, async () => true))) return true;
        await storage.put(manifest, job.artifactBytes, signal);
        const stored = await withClaim(job, async (tx, current) => {
          if (current.phase !== 'GENERATED') return false;
          await tx
            .update(legacyGiftCardBatches)
            .set({ completed: 1, filename: manifest.key })
            .where(eq(legacyGiftCardBatches.id, BigInt(job.batchId)));
          await tx
            .update(giftCardBatchJobs)
            .set({ phase: 'STORED', artifactBytes: null, updatedAt: repository.utc() })
            .where(eq(giftCardBatchJobs.id, current.id));
          return true;
        });
        if (!stored) return true;
        job.artifactBytes = null;
        stage = 'STORED';
      }
      if (stage === 'STORED') {
        const bytes = await storage.get(giftCardBatchManifest(job), signal);
        const attemptId = randomUUID();
        const sending = await withClaim(job, async (tx, current) => {
          if (current.phase !== 'STORED') return false;
          await tx
            .update(giftCardBatchJobs)
            .set({ phase: 'SENDING', deliveryAttemptId: attemptId, updatedAt: repository.utc() })
            .where(eq(giftCardBatchJobs.id, current.id));
          return true;
        });
        if (!sending) return true;
        stage = 'SENDING';
        const outcome = await delivery.send(
          attemptId,
          {
            batchId: job.batchId,
            recipient: secret.recipient,
            archive: bytes,
            ...(job.requestId ? { requestId: job.requestId } : {}),
          },
          signal,
        );
        // A returned provider outcome is evidence even if the owner changes during the request.
        await writer.transaction(async (tx) => {
          await repository.batch(tx, job.batchId, true);
          const current = await repository.job(tx, job.batchId, true);
          if (
            !current ||
            current.leaseToken !== job.leaseToken ||
            current.phase !== 'SENDING' ||
            current.deliveryAttemptId !== attemptId
          )
            return;
          await tx
            .update(giftCardBatchJobs)
            .set({
              phase:
                outcome === 'accepted'
                  ? 'DELIVERED'
                  : outcome === 'rejected'
                    ? 'FAILED'
                    : 'UNCERTAIN',
              errorCode:
                outcome === 'accepted'
                  ? null
                  : outcome === 'rejected'
                    ? 'GIFT_CARD_BATCH_DELIVERY_REJECTED'
                    : 'GIFT_CARD_BATCH_DELIVERY_UNCERTAIN',
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: repository.utc(),
            })
            .where(eq(giftCardBatchJobs.id, current.id));
        });
        log(
          outcome === 'accepted' ? 'info' : 'warn',
          event(`delivery-${outcome}`, job),
          'Gift card batch delivery outcome recorded',
        );
      }
      return true;
    } catch (error) {
      const errorCode =
        stage === 'SENDING'
          ? 'GIFT_CARD_BATCH_DELIVERY_UNCERTAIN'
          : error instanceof AppError && /^GIFT_CARD_[A-Z0-9_]+$/.test(error.code)
            ? error.code
            : 'GIFT_CARD_BATCH_PROCESSING_FAILED';
      await writer.transaction(async (tx) => {
        await repository.batch(tx, job.batchId, true);
        const current = await repository.job(tx, job.batchId, true);
        if (!current || current.leaseToken !== job.leaseToken) return;
        await tx
          .update(giftCardBatchJobs)
          .set({
            phase:
              current.phase === 'SENDING'
                ? 'UNCERTAIN'
                : current.attempts >= 5
                  ? 'FAILED'
                  : current.phase,
            errorCode,
            leaseToken: null,
            leaseExpiresAt:
              current.phase === 'SENDING' || current.attempts >= 5
                ? null
                : future(Math.min(60000, 1000 * 2 ** current.attempts)),
            updatedAt: repository.utc(),
          })
          .where(eq(giftCardBatchJobs.id, current.id));
      });
      log(
        'warn',
        event('processing-failed', job, errorCode),
        'Gift card batch needs retry or reconciliation',
      );
      return true;
    }
  }
  function runOnce() {
    if (!running)
      running = perform().finally(() => {
        running = undefined;
      });
    return running;
  }
  function start() {
    if (timer || stopping || !available) return;
    const tick = async () => {
      try {
        await runOnce();
      } catch {
        log(
          'warn',
          event('poll-failed', undefined, 'GIFT_CARD_BATCH_POLL_FAILED'),
          'Gift card worker poll failed',
        );
      }
      if (!stopping) timer = setTimeout(tick, options.GIFT_CARD_BATCH_WORKER_INTERVAL_MS);
    };
    timer = setTimeout(tick, 0);
  }
  return {
    available,
    start,
    runOnce,
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      controller.abort();
      try {
        await running;
      } catch {
        log(
          'warn',
          event('shutdown-failed', undefined, 'GIFT_CARD_BATCH_SHUTDOWN_FAILED'),
          'Gift card worker shutdown requires lease reconciliation',
        );
      }
    },
  };
}
