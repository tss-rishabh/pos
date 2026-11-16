import { checkoutClearanceSchema, type CheckoutClearance } from '../api/checkout-clearance';
import { db, type LocalDraft, type PosDatabase } from './database';
import { checkedSnapshot, draftContents } from './review-snapshot';

/** Only an authoritative clear can retire the original reviewed draft. */
export async function clearReviewedDraft(
  candidate: LocalDraft,
  supplied: CheckoutClearance,
  database: PosDatabase = db,
) {
  const proof = checkoutClearanceSchema.parse(supplied);
  if (
    proof.operatorId !== candidate.ownerId ||
    proof.draftId !== candidate.id ||
    proof.storeId !== candidate.storeId ||
    proof.counterId !== candidate.counterId ||
    proof.draftVersion !== candidate.updatedAt
  )
    throw new Error(
      'The clear confirmation does not match the original reviewed sale. Your local cart has been kept.',
    );
  return database.transaction(
    'rw',
    [
      database.drafts,
      database.operations,
      database.reviewSnapshots,
      database.completedSales,
      database.clearedDrafts,
      database.offlineCashReceipts,
    ],
    async () => {
      const key: [string, string] = [candidate.ownerId, candidate.id];
      if (await database.offlineCashReceipts.where('[ownerId+draftId]').equals(key).first())
        throw new Error('Cash has already been received for this sale. Its receipt has been kept.');
      if (await database.completedSales.get(key))
        throw new Error(
          'This sale already has a confirmed payment. Its local evidence has been kept.',
        );
      const cleared = await database.clearedDrafts.get(key);
      if (cleared) {
        if (
          cleared.checkoutId !== proof.checkoutId ||
          cleared.clearOperationId !== proof.operationId ||
          cleared.draftVersion !== proof.draftVersion ||
          cleared.storeId !== proof.storeId ||
          cleared.counterId !== proof.counterId ||
          cleared.reason !== proof.reason ||
          cleared.clearedAt !== proof.clearedAt
        )
          throw new Error(
            'This sale has a different clear confirmation. Your newer local cart has been kept.',
          );
        return {
          alreadyCleared: true,
          preservedDraftId: cleared.preservedDraftId,
          replacementDraftId: cleared.replacementDraftId,
        };
      }
      const review = await database.reviewSnapshots.get(key);
      if (!review)
        throw new Error(
          'The original reviewed snapshot is unavailable. Your local cart has been kept.',
        );
      const original = checkedSnapshot(review, candidate.ownerId, candidate.id);
      if (
        original.storeId !== proof.storeId ||
        original.counterId !== proof.counterId ||
        original.updatedAt !== proof.draftVersion ||
        review.checkoutId !== proof.checkoutId
      )
        throw new Error(
          'The clear confirmation does not match its saved snapshot. Your local cart has been kept.',
        );
      const latest = await database.drafts.get(key);
      let preservedDraftId: string | null = null;
      const replacementDraftId = crypto.randomUUID();
      if (latest && draftContents(latest) !== draftContents(original)) {
        preservedDraftId = replacementDraftId;
        await database.drafts.add({
          ...latest,
          id: replacementDraftId,
          version: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } else
        await database.drafts.add({
          ...original,
          id: replacementDraftId,
          customerId: null,
          lines: [],
          version: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      await database.clearedDrafts.add({
        ownerId: candidate.ownerId,
        draftId: candidate.id,
        storeId: proof.storeId,
        counterId: proof.counterId,
        checkoutId: proof.checkoutId,
        clearOperationId: proof.operationId,
        draftVersion: proof.draftVersion,
        clearedAt: proof.clearedAt,
        reason: proof.reason,
        preservedDraftId,
        replacementDraftId,
      });
      await database.drafts.delete(key);
      await database.reviewSnapshots.delete(key);
      await database.operations.where('[ownerId+draftId]').equals(key).delete();
      return { alreadyCleared: false, preservedDraftId, replacementDraftId };
    },
  );
}
