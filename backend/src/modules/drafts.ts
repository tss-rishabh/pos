import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../db/pools.js';
import { StoreCounter } from '../db/legacy-schema.js';
import { AppError } from '../domain/errors.js';
import { requireStore, type Principal } from '../domain/access.js';
import type { Draft } from '../domain/contracts.js';
import {
  idempotencyKey,
  readJson,
  readJsonMany,
  withStateLock,
  type PosStateStore,
} from './checkout/state-store.js';
import { identifier } from '../domain/validation.js';

const id = identifier;
export const draftMutationSchema = z
  .object({
    mutationId: z.uuid(),
    expectedVersion: z.number().int().min(0),
    draft: z
      .object({
        id: z.uuid(),
        storeId: id,
        counterId: id,
        customerId: id.nullable(),
        lines: z
          .array(
            z
              .object({
                productId: id,
                name: z.string().min(1).max(255),
                barcode: z.string().max(32).nullable(),
                unitPrice: z
                  .string()
                  .max(16)
                  .regex(/^\d+(?:\.\d{1,2})?$/),
                quantity: z.number().int().min(1).max(999),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
  })
  .strict();
export type DraftMutation = z.infer<typeof draftMutationSchema>;
export interface DraftService {
  save(user: Principal, input: DraftMutation): Promise<Draft>;
  list(user: Principal, storeId: string): Promise<Draft[]>;
}
/**
 * Server copy of a counter cart draft, re-homed from `pos_rewrite_drafts`/`pos_rewrite_mutations`
 * to Redis (table-disposition.md "checkout/drafts"). Legacy keeps tab state in Redis plus the
 * API-v2 cart (order/views.py:1657-1680, 2004); drafts hold no stock or money.
 * - `pos:draft:{operatorId}:{storeId}:{draftId}` → Draft JSON, EX 2 days (legacy
 *   REDIS_TAB_USER_OBJECT_EXPIRY has no default; the rewrite uses its open-sale TTL).
 * - `pos:drafts:{operatorId}:{storeId}` → JSON array of draft IDs (same EX), at most 100.
 * - `pos:idem:draft:{operatorId}:{mutationId}` → `{requestHash, result}`, EX 24 h.
 * - `pos:draft_lock:{operatorId}` → lock token while saving.
 */
export const DRAFT_TTL_SECONDS = 2 * 24 * 3600;
const draftSchema = draftMutationSchema.shape.draft.extend({ version: z.number().int().min(1) });
const receiptSchema = z.object({ requestHash: z.string(), result: draftSchema }).strict();
const draftKeys = {
  draft: (operatorId: string, storeId: string, draftId: string) =>
    `pos:draft:${operatorId}:${storeId}:${draftId}`,
  index: (operatorId: string, storeId: string) => `pos:drafts:${operatorId}:${storeId}`,
  lock: (operatorId: string) => `pos:draft_lock:${operatorId}`,
};
export function draftService(db: Databases, store: PosStateStore): DraftService {
  async function counterActive(storeId: string, counterId: string) {
    const [counter] = await db
      .get('writer')
      .select({ id: StoreCounter.id })
      .from(StoreCounter)
      .where(
        and(
          eq(StoreCounter.id, BigInt(counterId)),
          eq(StoreCounter.store, BigInt(storeId)),
          eq(StoreCounter.is_active, true),
        ),
      )
      .limit(1);
    return Boolean(counter);
  }
  return {
    async save(user, input) {
      requireStore(user, input.draft.storeId);
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      if (!(await counterActive(input.draft.storeId, input.draft.counterId)))
        throw new AppError(409, 'COUNTER_UNAVAILABLE', 'Select an active counter for this store.');
      return withStateLock(store, draftKeys.lock(user.id), async () => {
        const receiptKey = idempotencyKey('draft', user.id, input.mutationId);
        const receipt = await readJson(store, receiptKey, receiptSchema);
        if (receipt) {
          if (receipt.requestHash !== hash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This operation key was used with different data.',
            );
          return receipt.result;
        }
        const key = draftKeys.draft(user.id, input.draft.storeId, input.draft.id);
        const old = await readJson(store, key, draftSchema);
        if ((old?.version || 0) !== input.expectedVersion)
          throw new AppError(
            409,
            'DRAFT_CONFLICT',
            'This cart changed on another device. Review it before syncing.',
          );
        if (old && (old.storeId !== input.draft.storeId || old.counterId !== input.draft.counterId))
          throw new AppError(
            409,
            'DRAFT_SCOPE_CONFLICT',
            'A cart cannot move between stores or counters.',
          );
        const result: Draft = { ...input.draft, version: input.expectedVersion + 1 };
        const indexKey = draftKeys.index(user.id, input.draft.storeId);
        const index = (await readJson(store, indexKey, z.array(z.uuid()))) ?? [];
        if (!index.includes(result.id) && index.length >= 100)
          throw new AppError(
            409,
            'DRAFT_LIMIT_REACHED',
            'Too many saved carts at this store. Finish or clear one before saving another.',
          );
        await store.set(key, JSON.stringify(result), DRAFT_TTL_SECONDS);
        await store.set(
          indexKey,
          JSON.stringify(index.includes(result.id) ? index : [...index, result.id]),
          DRAFT_TTL_SECONDS,
        );
        await store.set(receiptKey, JSON.stringify({ requestHash: hash, result }), 24 * 3600);
        return result;
      });
    },
    async list(user, storeId) {
      requireStore(user, storeId);
      const index =
        (await readJson(store, draftKeys.index(user.id, storeId), z.array(z.uuid()))) ?? [];
      // One MGET for the whole index (at most 100 drafts); expired drafts drop out, in order.
      const drafts = await readJsonMany(
        store,
        index.map((draftId) => draftKeys.draft(user.id, storeId, draftId)),
        draftSchema,
      );
      return drafts.filter((draft): draft is Draft => draft !== null);
    },
  };
}
