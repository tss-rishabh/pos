import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../db/pools.js';
import { drafts, mutations } from '../db/rewrite-schema.js';
import { StoreCounter } from '../db/legacy-schema.js';
import { AppError } from '../domain/errors.js';
import { requireStore, type Principal } from '../domain/access.js';
import type { Draft } from '../domain/contracts.js';
import { retryTransaction } from '../db/retry.js';
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
export function draftService(db: Databases): DraftService {
  return {
    async save(user, input) {
      requireStore(user, input.draft.storeId);
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const [counter] = await tx
            .select({ id: StoreCounter.id })
            .from(StoreCounter)
            .where(
              and(
                eq(StoreCounter.id, BigInt(input.draft.counterId)),
                eq(StoreCounter.store, BigInt(input.draft.storeId)),
                eq(StoreCounter.is_active, true),
              ),
            )
            .limit(1);
          if (!counter)
            throw new AppError(
              409,
              'COUNTER_UNAVAILABLE',
              'Select an active counter for this store.',
            );
          // A unique reservation serializes retries across processes and commits
          // the cached result in the same transaction as the draft update.
          await tx
            .insert(mutations)
            .values({ operatorId: user.id, id: input.mutationId, requestHash: hash })
            .onDuplicateKeyUpdate({ set: { id: input.mutationId } });
          const [reservation] = await tx
            .select()
            .from(mutations)
            .where(and(eq(mutations.operatorId, user.id), eq(mutations.id, input.mutationId)))
            .for('update');
          if (reservation!.requestHash !== hash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This operation key was used with different data.',
            );
          if (reservation!.result) return reservation!.result;
          const [old] = await tx
            .select()
            .from(drafts)
            .where(and(eq(drafts.operatorId, user.id), eq(drafts.id, input.draft.id)))
            .for('update');
          if ((old?.version || 0) !== input.expectedVersion)
            throw new AppError(
              409,
              'DRAFT_CONFLICT',
              'This cart changed on another device. Review it before syncing.',
            );
          if (
            old &&
            (old.storeId !== input.draft.storeId || old.counterId !== input.draft.counterId)
          )
            throw new AppError(
              409,
              'DRAFT_SCOPE_CONFLICT',
              'A cart cannot move between stores or counters.',
            );
          const result: Draft = { ...input.draft, version: input.expectedVersion + 1 };
          await tx
            .insert(drafts)
            .values({
              operatorId: user.id,
              id: result.id,
              storeId: result.storeId,
              counterId: result.counterId,
              version: result.version,
              payload: result,
            })
            .onDuplicateKeyUpdate({ set: { version: result.version, payload: result } });
          await tx
            .update(mutations)
            .set({ result })
            .where(and(eq(mutations.operatorId, user.id), eq(mutations.id, input.mutationId)));
          return result;
        }),
      );
    },
    async list(user, storeId) {
      requireStore(user, storeId);
      return (
        await db
          .get('writer')
          .select({ payload: drafts.payload })
          .from(drafts)
          .where(and(eq(drafts.operatorId, user.id), eq(drafts.storeId, storeId)))
          .limit(100)
      ).map((r) => r.payload);
    },
  };
}
