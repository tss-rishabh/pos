import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { JobArgs, JobContext } from '../../jobs/contract.js';
import type { JobLogger, JobModuleRegistration } from '../../jobs/runtime.js';
import type { Databases } from '../../db/pools.js';
import { GiftCardCollection, PosUser } from '../../db/legacy-schema.js';
import {
  generateGiftCardBatchArgs,
  type GiftCardBatchDelivery,
  type GiftCardBatchStorage,
} from './contracts.js';
import { giftCardArchive } from './archives.js';
import { createGiftCardBatchDelivery } from './delivery.js';
import {
  generateGiftCards,
  giftCardArchiveNames,
  giftCardArchivePassword,
  giftCardCsv,
  giftCardRecipient,
  type RandomInteger,
} from './generation.js';
import { readGiftCardBatchOptions, type GiftCardBatchOptions } from './options.js';
import { createGiftCardBatchStorage } from './storage.js';
import type { EventId } from '../../observability/event-registry.js';

export const giftCardBatchJobName = 'pos.gift_card_batches.generate' as const;

export interface GiftCardBatchGenerationDependencies {
  db: Databases;
  options: Pick<GiftCardBatchOptions, 'GC_SALTKEY'>;
  storage: GiftCardBatchStorage | undefined;
  delivery: GiftCardBatchDelivery | undefined;
  log: JobLogger;
  /** Wall clock in epoch microseconds (legacy `datetime.now().timestamp()`). */
  nowMicroseconds?: () => bigint;
  random?: RandomInteger;
}

const truncate = (value: string, length: number) => [...value].slice(0, length).join('');

/**
 * `core.tasks.generate_and_upload_gift_card(id, size, user_phone, email)` (core/tasks.py:208-223)
 * with `Helpers.generate_gift_card` and `upload_save_data` (helpers/helpers.py:1265-1371).
 * Legacy outcomes are kept: generation or archive failure leaves `is_completed=0`; a storage or
 * email failure is logged and swallowed, and the collection is still completed.
 * The phone and email are read here from pos_user (job args carry ids only).
 */
export async function generateGiftCardBatch(
  dependencies: GiftCardBatchGenerationDependencies,
  rawArgs: JobArgs,
  context: Pick<JobContext, 'jobId' | 'requestId' | 'userId' | 'signal'>,
) {
  const args = generateGiftCardBatchArgs.parse(rawArgs);
  const event = (eventId: EventId) => ({
    module: 'gift-card-batches',
    resource: 'batch',
    eventId,
    eventInstanceId: randomUUID(),
    requestId: context.requestId ?? context.jobId,
    userId: context.userId ?? args.userId,
    jobId: context.jobId,
    batchId: args.collectionId,
  });
  const writer = dependencies.db.get('writer');
  const [collection] = await writer
    .select({ completed: GiftCardCollection.is_completed })
    .from(GiftCardCollection)
    .where(eq(GiftCardCollection.id, BigInt(args.collectionId)))
    .limit(1);
  if (!collection) {
    dependencies.log(
      'warn',
      event('gift-card-batches.batch.missing'),
      'Gift card collection was not found',
    );
    return;
  }
  if (collection.completed === 1) {
    dependencies.log(
      'info',
      event('gift-card-batches.batch.already-completed'),
      'Gift card collection already completed',
    );
    return;
  }
  const [user] = await writer
    .select({ phone: PosUser.phone, email: PosUser.email })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(args.userId)))
    .limit(1);
  const email = giftCardRecipient(user?.email ?? null);
  if (!user || !email) {
    dependencies.log(
      'error',
      event('gift-card-batches.batch.not-eligible'),
      'Gift card requester has no email',
    );
    return;
  }
  let csv: Buffer;
  try {
    if (!dependencies.options.GC_SALTKEY) throw new Error('GC_SALTKEY missing');
    const cards = generateGiftCards(
      args.collectionId,
      args.size,
      dependencies.options.GC_SALTKEY,
      dependencies.random,
    );
    csv = giftCardCsv(cards);
  } catch {
    dependencies.log(
      'error',
      event('gift-card-batches.batch.generation-failed'),
      'Gift card generation failed',
    );
    return;
  }
  const micros =
      dependencies.nowMicroseconds?.() ??
      BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)),
    names = giftCardArchiveNames(micros, dependencies.random);
  let archive: Buffer;
  try {
    archive = await giftCardArchive(
      csv,
      names.entry,
      giftCardArchivePassword(user.phone, args.collectionId),
      new Date(Number(micros / 1000n)),
      context.signal,
    );
  } catch {
    dependencies.log(
      'error',
      event('gift-card-batches.batch.upload-failed'),
      'Gift card upload failed',
    );
    return;
  }
  try {
    if (!dependencies.storage) throw new Error('storage not configured');
    await dependencies.storage.upload(names.key, archive, context.signal);
  } catch {
    dependencies.log(
      'error',
      event('gift-card-batches.batch.storage-failed'),
      'Gift card storage upload failed',
    );
  }
  const sent = dependencies.delivery
    ? await dependencies.delivery.send(
        { collectionId: args.collectionId, recipient: email, archive },
        context.signal,
      )
    : false;
  if (!sent)
    dependencies.log(
      'error',
      event('gift-card-batches.batch.email-failed'),
      'Gift card email send failed',
    );
  const [current] = await writer
    .select({ message: GiftCardCollection.message })
    .from(GiftCardCollection)
    .where(eq(GiftCardCollection.id, BigInt(args.collectionId)))
    .limit(1);
  await writer
    .update(GiftCardCollection)
    .set({
      filename: names.key,
      is_completed: 1,
      message: truncate((current?.message ?? '') + `| File has been sent on ${email}`, 255),
    })
    .where(eq(GiftCardCollection.id, BigInt(args.collectionId)));
  dependencies.log(
    'info',
    event('gift-card-batches.batch.generated'),
    'Gift card collection generated and uploaded',
  );
}

/** Worker registration: one handler for the approved `pos.gift_card_batches.generate` job. */
export function giftCardBatchJobRegistration(
  options: GiftCardBatchOptions = readGiftCardBatchOptions(),
): JobModuleRegistration {
  return (registry, runtime) => {
    let adapters:
      | { storage: GiftCardBatchStorage | undefined; delivery: GiftCardBatchDelivery | undefined }
      | undefined;
    const adaptersFor = (config: Config) =>
      (adapters ??= {
        storage: createGiftCardBatchStorage(config, options),
        delivery: createGiftCardBatchDelivery(options),
      });
    registry.register(giftCardBatchJobName, (args, context) =>
      generateGiftCardBatch(
        { db: runtime.db, options, ...adaptersFor(runtime.config), log: runtime.log },
        args,
        context,
      ),
    );
  };
}

/** pos.gift_card_batches.generate (approved divergence from legacy inline C11). */
export const registerJobHandlers: JobModuleRegistration = (registry, runtime) =>
  giftCardBatchJobRegistration()(registry, runtime);
