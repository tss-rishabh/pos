import { z } from 'zod';
import { draftSchema } from '../api/schemas';
import { db, type LocalDraft, type PosDatabase, type ReviewSnapshot } from './database';

const snapshotSchema = draftSchema.extend({
  ownerId: z.string().regex(/^[1-9]\d{0,19}$/),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export function draftContents(draft: LocalDraft) {
  return JSON.stringify([draft.storeId, draft.counterId, draft.customerId, draft.lines]);
}
export function checkedSnapshot(
  record: ReviewSnapshot,
  ownerId: string,
  draftId: string,
): LocalDraft {
  const result = snapshotSchema.safeParse(record.snapshot);
  if (
    !result.success ||
    record.ownerId !== ownerId ||
    record.draftId !== draftId ||
    result.data.ownerId !== ownerId ||
    result.data.id !== draftId
  )
    throw new Error(
      'The original checkout snapshot is unavailable. Your local cart has been kept.',
    );
  return result.data;
}
/** Bind the first validated server session before any completion callback. */
export async function bindReviewedCheckout(
  candidate: LocalDraft,
  checkoutId: string,
  database: PosDatabase = db,
) {
  z.uuid().parse(checkoutId);
  return database.transaction(
    'rw',
    [
      database.reviewSnapshots,
      database.clearedDrafts,
      database.completedSales,
      database.offlineCashReceipts,
    ],
    async () => {
      const key: [string, string] = [candidate.ownerId, candidate.id],
        cleared = await database.clearedDrafts.get(key);
      if (await database.offlineCashReceipts.where('[ownerId+draftId]').equals(key).first())
        throw new Error('Cash has already been received for this sale. Open its saved receipt.');
      if (cleared) {
        if (
          cleared.checkoutId !== checkoutId ||
          cleared.draftVersion !== candidate.updatedAt ||
          cleared.storeId !== candidate.storeId ||
          cleared.counterId !== candidate.counterId
        )
          throw new Error('The cleared checkout does not match this original snapshot.');
        return { cleared: true };
      }
      if (await database.completedSales.get(key)) return { cleared: false };
      const record = await database.reviewSnapshots.get(key);
      if (!record)
        throw new Error(
          'The original checkout snapshot is unavailable. Your local cart has been kept.',
        );
      const original = checkedSnapshot(record, candidate.ownerId, candidate.id);
      if (
        original.updatedAt !== candidate.updatedAt ||
        original.storeId !== candidate.storeId ||
        original.counterId !== candidate.counterId ||
        (record.checkoutId && record.checkoutId !== checkoutId)
      )
        throw new Error('The server checkout does not match the original reviewed snapshot.');
      if (!record.checkoutId) await database.reviewSnapshots.put({ ...record, checkoutId });
      return { cleared: false };
    },
  );
}
/** The first writer wins across tabs; a recovered checkout can never freeze a newer cart. */
export async function prepareReview(
  candidate: LocalDraft,
  recovery: { draftVersion: number } | null = null,
  database: PosDatabase = db,
) {
  return database.transaction(
    'rw',
    [
      database.drafts,
      database.reviewSnapshots,
      database.completedSales,
      database.clearedDrafts,
      database.offlineCashReceipts,
    ],
    async () => {
      const key: [string, string] = [candidate.ownerId, candidate.id];
      if (await database.offlineCashReceipts.where('[ownerId+draftId]').equals(key).first())
        throw new Error('Cash has already been received for this sale. Open its saved receipt.');
      if (await database.clearedDrafts.get(key))
        throw new Error(
          'This checkout was cleared. Open a new sale; the original items will not be imported again.',
        );
      if (await database.completedSales.get(key))
        throw new Error('This sale is already confirmed. Open a new sale.');
      const current = await database.drafts.get(key);
      if (
        !current ||
        current.storeId !== candidate.storeId ||
        current.counterId !== candidate.counterId
      )
        throw new Error('This local cart is no longer available in the selected counter.');
      const existing = await database.reviewSnapshots.get(key);
      if (!existing && recovery)
        throw new Error(
          'This checkout has no original saved snapshot. Review its order before continuing; your local cart has been kept.',
        );
      const snapshot = existing
        ? checkedSnapshot(existing, candidate.ownerId, candidate.id)
        : snapshotSchema.parse(current);
      if (
        snapshot.storeId !== candidate.storeId ||
        snapshot.counterId !== candidate.counterId ||
        (recovery && recovery.draftVersion !== snapshot.updatedAt)
      )
        throw new Error(
          'The saved checkout does not match its original cart. Review its order before continuing; your local cart has been kept.',
        );
      if (!existing)
        await database.reviewSnapshots.add({
          ownerId: candidate.ownerId,
          draftId: candidate.id,
          snapshot,
          createdAt: Date.now(),
        });
      return { snapshot, changed: draftContents(current) !== draftContents(snapshot) };
    },
  );
}
