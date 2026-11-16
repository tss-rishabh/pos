import { db, type LocalDraft, type PosDatabase } from './database';
import { checkedSnapshot, draftContents } from './review-snapshot';

export type PaidReceipt = {
  status: 'paid';
  orderId: string;
  receiptId: string;
  transactionId: string;
} & (
  | { source: 'counter'; paymentAttemptId: string }
  | { source: 'prepaid'; checkoutId: string; checkoutOperationId: string }
);
/** Only a confirmed server payment can archive a draft. Changes in another tab become a new sale. */
export async function completeSale(
  snapshot: LocalDraft,
  receipt: PaidReceipt,
  database: PosDatabase = db,
) {
  if (receipt.status !== 'paid')
    throw new Error('Payment must be confirmed before completing this sale.');
  if (
    receipt.receiptId !==
    (receipt.source === 'counter' ? receipt.paymentAttemptId : receipt.checkoutOperationId)
  )
    throw new Error('The confirmed payment receipt has inconsistent evidence.');
  return database.transaction(
    'rw',
    database.drafts,
    database.operations,
    database.completedSales,
    database.reviewSnapshots,
    async () => {
      const key: [string, string] = [snapshot.ownerId, snapshot.id];
      const completed = await database.completedSales.get(key);
      if (completed) {
        if (
          completed.orderId !== receipt.orderId ||
          (completed.source ? completed.receiptId : completed.paymentAttemptId) !==
            receipt.receiptId
        )
          throw new Error(
            'This sale has a different confirmed payment. Review the order before continuing.',
          );
        return { alreadyCompleted: true, preservedDraftId: null };
      }
      const review = await database.reviewSnapshots.get(key);
      if (!review)
        throw new Error(
          'The original checkout snapshot is unavailable. Your local cart has been kept.',
        );
      const original = checkedSnapshot(review, snapshot.ownerId, snapshot.id);
      if (original.storeId !== snapshot.storeId || original.counterId !== snapshot.counterId)
        throw new Error(
          'The payment does not match the original checkout counter. Your local cart has been kept.',
        );
      const latest = await database.drafts.get(key);
      let preservedDraftId: string | null = null;
      if (latest && draftContents(latest) !== draftContents(original)) {
        preservedDraftId = crypto.randomUUID();
        await database.drafts.put({
          ...latest,
          id: preservedDraftId,
          version: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      const evidence =
        receipt.source === 'counter'
          ? {
              source: 'counter' as const,
              receiptId: receipt.receiptId,
              paymentAttemptId: receipt.paymentAttemptId,
            }
          : {
              source: 'prepaid' as const,
              receiptId: receipt.receiptId,
              checkoutId: receipt.checkoutId,
              checkoutOperationId: receipt.checkoutOperationId,
            };
      await database.completedSales.put({
        ownerId: snapshot.ownerId,
        draftId: snapshot.id,
        storeId: original.storeId,
        orderId: receipt.orderId,
        ...evidence,
        transactionId: receipt.transactionId,
        completedAt: Date.now(),
      });
      await database.drafts.delete(key);
      await database.reviewSnapshots.delete(key);
      await database.operations.where('[ownerId+draftId]').equals(key).delete();
      return { alreadyCompleted: false, preservedDraftId };
    },
  );
}
