import { createHmac } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { asc, desc, eq, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { generatedId } from '../../db/generated-id.js';
import {
  GiftCardCollection,
  PosSpecialPermissionActivityLog,
  PosUser,
} from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import type { JobProducer } from '../../jobs/contract.js';
import { sourceAdministrationFullName } from '../administration-history/messages.js';
import {
  blockGiftCardBatchInput,
  createGiftCardBatchInput,
  giftCardBatchListInput,
  type GiftCardBatchResult,
} from './contracts.js';
import { giftCardRecipient } from './generation.js';
import { giftCardBatchJobName } from './jobs.js';
import type { GiftCardBatchOptions } from './options.js';

export interface GiftCardBatchDependencies {
  jobs: JobProducer;
  ephemeral: EphemeralStore;
  clock?: () => Temporal.Instant;
}
type Transaction = Parameters<Parameters<ReturnType<Databases['get']>['transaction']>[0]>[0];

/** Redis idempotency receipt for batch creation (ledger: pos_rewrite_gift_card_batch_mutations). */
export const giftCardBatchReceiptKey = (operationId: string) =>
  `pos:idem:gift_card_batch:${operationId}`;
const receiptTtlSeconds = 86400;
const receipt = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), actorId: z.string(), inputHash: z.string() }),
  z.object({
    state: z.literal('created'),
    actorId: z.string(),
    inputHash: z.string(),
    batchId: z.string(),
  }),
  z.object({
    state: z.literal('done'),
    actorId: z.string(),
    inputHash: z.string(),
    batchId: z.string(),
    outcome: z.enum(['queued', 'not-eligible']),
  }),
]);
type Receipt = z.infer<typeof receipt>;

const queuedMessage = 'Gift card generation started. The file will be emailed to you.';
const notEligible = () =>
  new AppError(422, 'GIFT_CARD_BATCH_NOT_ELIGIBLE', 'Not Eligible to generate the GCs.');
const notFound = () =>
  new AppError(404, 'GIFT_CARD_BATCH_NOT_FOUND', 'Gift card batch was not found.');

/** Django paginator fallback (gift_card_datatable.py:52-60): invalid or empty pages show page 1. */
export function giftCardBatchPageStart(start: number, length: number, total: bigint) {
  return start < 0 || start % length !== 0 || BigInt(start) >= total ? 0 : start;
}
export function giftCardBatchPattern(search: string) {
  return '%' + search.replace(/[\\%_]/g, (value) => '\\' + value) + '%';
}

export function giftCardBatchService(
  config: Config,
  db: Databases,
  options: GiftCardBatchOptions,
  dependencies: GiftCardBatchDependencies,
) {
  const clock = dependencies.clock ?? (() => Temporal.Now.instant());
  const wall = () =>
    clock()
      .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const configured = () =>
    Boolean(
      options.GC_SALTKEY &&
      options.NETCORE_EMAIL_URL &&
      options.NETCORE_API_KEY &&
      options.AWS_STORAGE_BUCKET_NAME,
    );
  /**
   * `advance_permisson("[1,2]")` on every view, `user_type_exempt("[2]")` on the page and list
   * (core/views.py:2169-2170, gift_card_datatable.py:15-16). Writer read: authorization
   * confirmation uses the writer (AGENTS.md).
   */
  async function actor(tx: Transaction, user: Principal) {
    const [row] = await tx
      .select({
        id: PosUser.id,
        isActive: PosUser.is_active,
        role: PosUser.role,
        userType: PosUser.user_type,
        email: PosUser.email,
      })
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1);
    if (!row?.isActive) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    if (![1, 2].includes(row.role) || row.userType === 2)
      throw new AppError(
        403,
        'GIFT_CARD_BATCH_ACCESS_DENIED',
        'Gift card batches need an administrator or manager account.',
      );
    return row;
  }
  const inputHash = (value: unknown) =>
    createHmac('sha256', config.SESSION_SECRET).update(JSON.stringify(value)).digest('hex');
  async function readReceipt(key: string) {
    const raw = await dependencies.ephemeral.get(key);
    if (raw === null) return null;
    try {
      return receipt.parse(JSON.parse(raw) as unknown);
    } catch {
      throw new AppError(409, 'GIFT_CARD_BATCH_OPERATION_REUSED', 'Choose a new operation.');
    }
  }
  const writeReceipt = (key: string, value: Receipt) =>
    dependencies.ephemeral.set(key, JSON.stringify(value), { EX: receiptTtlSeconds });
  function replay(previous: Receipt, actorId: string, hash: string): GiftCardBatchResult {
    if (previous.actorId !== actorId || previous.inputHash !== hash)
      throw new AppError(
        409,
        'GIFT_CARD_BATCH_OPERATION_REUSED',
        'Choose a new gift card batch operation.',
      );
    if (previous.state === 'pending')
      throw new AppError(409, 'GIFT_CARD_BATCH_BUSY', 'This batch request is still in progress.');
    if (previous.state === 'created')
      throw new AppError(
        503,
        'GIFT_CARD_BATCH_QUEUE_FAILED',
        `Batch ${previous.batchId} was saved but generation could not be started. Generate a new batch.`,
      );
    if (previous.outcome === 'not-eligible') throw notEligible();
    return { batchId: previous.batchId, status: 'success', message: queuedMessage };
  }
  async function flag(
    user: Principal,
    id: string,
    values: { is_printed: 1 } | { is_block: 0 | 1 },
    message: string,
  ) {
    await db.get('writer').transaction(async (tx) => {
      await actor(tx, user);
      const [row] = await tx
        .select({ id: GiftCardCollection.id })
        .from(GiftCardCollection)
        .where(eq(GiftCardCollection.id, BigInt(id)))
        .limit(1);
      if (!row) throw notFound();
      await tx
        .update(GiftCardCollection)
        .set(values)
        .where(eq(GiftCardCollection.id, BigInt(id)));
    });
    return { batchId: id, status: 'success' as const, message };
  }
  return {
    /** `GiftCardView` (core/views.py:2171-2180): the page shows the cleaned delivery email. */
    async capabilities(user: Principal) {
      const row = await db.get('writer').transaction((tx) => actor(tx, user));
      const email = giftCardRecipient(row.email);
      return { email: email || null, generationAvailable: configured() };
    },
    /**
     * `AjaxGenerateGiftCardView.post` (core/views.py:2186-2210): insert gift_card_collection,
     * then (after commit) enqueue `pos.gift_card_batches.generate` on queue `core`.
     */
    async create(user: Principal, raw: unknown): Promise<GiftCardBatchResult> {
      const input = createGiftCardBatchInput.parse(raw),
        key = giftCardBatchReceiptKey(input.operationId),
        hash = inputHash({ size: input.size, message: input.message });
      const previous = await readReceipt(key);
      if (previous) return replay(previous, user.id, hash);
      if (!configured())
        throw new AppError(
          503,
          'GIFT_CARD_BATCH_GENERATION_UNAVAILABLE',
          'Gift card generation is not configured (GC_SALTKEY, storage bucket and Netcore email).',
        );
      if (
        !(await dependencies.ephemeral.set(
          key,
          JSON.stringify({ state: 'pending', actorId: user.id, inputHash: hash } satisfies Receipt),
          { NX: true, EX: receiptTtlSeconds },
        ))
      ) {
        const raced = await readReceipt(key);
        if (raced) return replay(raced, user.id, hash);
      }
      let created: { batchId: string; email: string };
      try {
        created = await db.get('writer').transaction(async (tx) => {
          const row = await actor(tx, user);
          const [encoding] = await tx
            .select({
              valid:
                sql<boolean>`CAST(CONVERT(CONVERT(${input.message} USING latin1) USING utf8mb4) AS BINARY)=CAST(${input.message} AS BINARY)`.mapWith(
                  (value: unknown) => value === true || String(value) === '1',
                ),
            })
            .from(PosUser)
            .where(eq(PosUser.id, row.id))
            .limit(1);
          if (!encoding?.valid)
            throw new AppError(
              400,
              'GIFT_CARD_BATCH_MESSAGE_ENCODING',
              'Use characters supported by the batch message field.',
            );
          const batchId = generatedId(
            await tx.insert(GiftCardCollection).values({
              size: input.size,
              message: input.message,
              is_completed: 0,
              is_block: 0,
              is_printed: 0,
              created_by: row.id,
              created_at: wall(),
              filename: '',
            }),
          ).toString();
          return { batchId, email: giftCardRecipient(row.email) };
        });
      } catch (error) {
        await dependencies.ephemeral.del(key).catch(() => 0);
        throw error;
      }
      // Legacy creates the collection first, then refuses requesters without an email.
      if (!created.email) {
        await writeReceipt(key, {
          state: 'done',
          actorId: user.id,
          inputHash: hash,
          batchId: created.batchId,
          outcome: 'not-eligible',
        });
        throw notEligible();
      }
      await writeReceipt(key, {
        state: 'created',
        actorId: user.id,
        inputHash: hash,
        batchId: created.batchId,
      });
      await dependencies.jobs.enqueue(
        giftCardBatchJobName,
        { collectionId: created.batchId, size: input.size, userId: user.id },
        { queue: 'core' },
      );
      await writeReceipt(key, {
        state: 'done',
        actorId: user.id,
        inputHash: hash,
        batchId: created.batchId,
        outcome: 'queued',
      });
      return { batchId: created.batchId, status: 'success', message: queuedMessage };
    },
    /** `AjaxPrintGiftCardView` (core/views.py:2213-2229): sets is_printed=1. */
    markPrinted(user: Principal, id: string) {
      return flag(user, id, { is_printed: 1 }, 'Marked as printed');
    },
    /** `AjaxBlockGiftCardView` (core/views.py:2232-2252): `opr=active` → 0, otherwise 1. */
    setBlocked(user: Principal, id: string, raw: unknown) {
      const input = blockGiftCardBatchInput.parse(raw);
      return flag(user, id, { is_block: input.opr === 'active' ? 0 : 1 }, `Marked as ${input.opr}`);
    },
    /**
     * `AjaxGiftCardListView` (core/datatables/gift_card_datatable.py:18-90): all collections,
     * one sort column, Django paginator fallback, creator full names, and the special-permission
     * activity row on the first draw. Interactive read: primary reader.
     */
    async list(user: Principal, raw: unknown) {
      const input = giftCardBatchListInput.parse(raw);
      await db.get('writer').transaction(async (tx) => {
        await actor(tx, user);
        if (input.draw === 1) {
          const now = wall();
          await tx.insert(PosSpecialPermissionActivityLog).values({
            pos_user_id: BigInt(user.id),
            platform: 'Gift Card',
            comment: 'Viewed the gift card batch list',
            recipient: null,
            created_at: now,
            updated_at: now,
          });
        }
      });
      const columns = {
        id: GiftCardCollection.id,
        size: GiftCardCollection.size,
        message: GiftCardCollection.message,
        created_by: GiftCardCollection.created_by,
        created_at: GiftCardCollection.created_at,
      };
      const pattern = giftCardBatchPattern(input.search);
      // Legacy configures `product__product__icontains | product__id__icontains`
      // (`core/datatables/gift_card_datatable.py:47-51`), but `gift_card_collection` has no
      // product relation (`core/models.py:742-757`), so legacy raises FieldError. Kept working
      // (user decision N7) and limited to the configured fields that exist: the `id` lookup.
      // The product name has no column here, so it is not searched.
      const condition = input.search
        ? like(sql`CAST(${GiftCardCollection.id} AS CHAR)`, pattern)
        : undefined;
      const reader = db.get('primary');
      const [tally] = await reader
        .select({ total: sql<string>`CAST(COUNT(*) AS CHAR)` })
        .from(GiftCardCollection)
        .where(condition);
      const total = BigInt(tally?.total ?? '0'),
        start = giftCardBatchPageStart(input.start, input.length, total);
      const rows =
        total === 0n
          ? []
          : await reader
              .select({
                id: sql<string>`CAST(${GiftCardCollection.id} AS CHAR)`,
                size: GiftCardCollection.size,
                message: GiftCardCollection.message,
                completed: GiftCardCollection.is_completed,
                printed: GiftCardCollection.is_printed,
                blocked: GiftCardCollection.is_block,
                firstName: PosUser.first_name,
                lastName: PosUser.last_name,
                creator: PosUser.id,
                createdAt: GiftCardCollection.created_at,
              })
              .from(GiftCardCollection)
              .leftJoin(PosUser, eq(PosUser.id, GiftCardCollection.created_by))
              .where(condition)
              .orderBy(
                input.direction === 'asc' ? asc(columns[input.sort]) : desc(columns[input.sort]),
                ...(input.sort === 'id' ? [] : [asc(GiftCardCollection.id)]),
              )
              .limit(input.length)
              .offset(start);
      return {
        draw: input.draw,
        recordsTotal: total.toString(),
        recordsFiltered: total.toString(),
        start,
        length: input.length,
        data: rows.map((row) => ({
          id: row.id,
          size: row.size,
          message: row.message,
          completed: row.completed !== 0,
          printed: row.printed !== 0,
          blocked: row.blocked !== 0,
          createdBy:
            row.creator === null ? '' : sourceAdministrationFullName(row.firstName, row.lastName),
          createdAt: row.createdAt,
        })),
      };
    },
  };
}
export type GiftCardBatchService = ReturnType<typeof giftCardBatchService>;
