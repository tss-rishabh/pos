import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PosDatabase, type LocalDraft } from '../src/offline/database';
import { clearReviewedDraft } from '../src/offline/clear-reviewed-draft';
import { bindReviewedCheckout, prepareReview } from '../src/offline/review-snapshot';
import { queueDraft } from '../src/offline/sync';
import { completeSale } from '../src/offline/complete-sale';
import type { CheckoutClearance } from '../src/api/checkout-clearance';

let database: PosDatabase;
beforeEach(() => {
  database = new PosDatabase('clear-review-' + crypto.randomUUID());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.delete();
});
const sale = (): LocalDraft => ({
  id: crypto.randomUUID(),
  ownerId: '1',
  storeId: '1',
  counterId: '1',
  customerId: null,
  lines: [{ productId: '1', name: 'Fixture', barcode: null, unitPrice: '10.00', quantity: 1 }],
  version: 1,
  createdAt: 1,
  updatedAt: 2,
});
const proofFor = (draft: LocalDraft): CheckoutClearance => ({
  status: 'cleared',
  checkoutId: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  operatorId: draft.ownerId,
  storeId: draft.storeId,
  counterId: draft.counterId,
  draftId: draft.id,
  draftVersion: draft.updatedAt,
  reason: 'customer-detach',
  clearedAt: Date.now(),
});
async function prepared() {
  const draft = sale(),
    proof = proofFor(draft);
  await database.drafts.put(draft);
  await prepareReview(draft, null, database);
  await bindReviewedCheckout(draft, proof.checkoutId, database);
  return { draft, proof };
}
it('retires only the proved review and atomically creates a fresh empty draft without a paid receipt', async () => {
  const { draft, proof } = await prepared();
  await queueDraft(draft, database);
  const result = await clearReviewedDraft(draft, proof, database);
  expect(result).toMatchObject({ alreadyCleared: false, preservedDraftId: null });
  expect(result.replacementDraftId).not.toBe(draft.id);
  expect(await database.drafts.toArray()).toEqual([
    expect.objectContaining({ id: result.replacementDraftId, lines: [], version: 0, ownerId: '1' }),
  ]);
  expect(await database.completedSales.count()).toBe(0);
  expect(await database.operations.count()).toBe(0);
  expect(await database.reviewSnapshots.count()).toBe(0);
  expect(await database.clearedDrafts.count()).toBe(1);
  const payment = crypto.randomUUID();
  await expect(
    completeSale(
      draft,
      {
        status: 'paid',
        source: 'counter',
        receiptId: payment,
        paymentAttemptId: payment,
        orderId: '999',
        transactionId: 'fixture-conflict',
      },
      database,
    ),
  ).rejects.toThrow('snapshot is unavailable');
  expect(await database.completedSales.count()).toBe(0);
  await expect(queueDraft(draft, database)).rejects.toThrow('cleared');
  // An old tab or import cannot re-open even a reinserted original local ID.
  await database.drafts.put(draft);
  await expect(prepareReview(draft, null, database)).rejects.toThrow('cleared');
});
it('preserves later edits once across simultaneous callbacks, a database restart and repeated evidence', async () => {
  const { draft, proof } = await prepared();
  await database.drafts.put({ ...draft, lines: [{ ...draft.lines[0]!, quantity: 2 }] });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => clearReviewedDraft(draft, proof, database)),
  );
  expect(results.filter((result) => !result.alreadyCleared)).toHaveLength(1);
  expect(new Set(results.map((result) => result.replacementDraftId)).size).toBe(1);
  const kept = results[0]!.replacementDraftId;
  expect(await database.drafts.get(['1', kept])).toMatchObject({
    version: 0,
    lines: [{ quantity: 2 }],
  });
  await database.drafts.update(['1', kept], { lines: [{ ...draft.lines[0]!, quantity: 3 }] });
  const name = database.name;
  database.close();
  database = new PosDatabase(name);
  expect((await clearReviewedDraft(draft, proof, database)).alreadyCleared).toBe(true);
  expect(await database.drafts.toArray()).toEqual([
    expect.objectContaining({ id: kept, lines: [expect.objectContaining({ quantity: 3 })] }),
  ]);
  expect(await database.completedSales.count()).toBe(0);
});
it('binds evidence to owner, store, counter, server session and original snapshot version', async () => {
  const { draft, proof } = await prepared();
  for (const change of [
    { operatorId: '2' },
    { storeId: '2' },
    { counterId: '2' },
    { draftId: crypto.randomUUID() },
    { draftVersion: 3 },
    { checkoutId: crypto.randomUUID() },
  ])
    await expect(clearReviewedDraft(draft, { ...proof, ...change }, database)).rejects.toThrow();
  await expect(bindReviewedCheckout(draft, crypto.randomUUID(), database)).rejects.toThrow(
    'does not match',
  );
  expect(await database.drafts.get(['1', draft.id])).toEqual(draft);
  expect(await database.clearedDrafts.count()).toBe(0);
});
it('keeps paid evidence and every newer cart when a conflicting or replayed clear is supplied', async () => {
  const { draft, proof } = await prepared();
  const payment = crypto.randomUUID();
  await completeSale(
    draft,
    {
      status: 'paid',
      source: 'counter',
      receiptId: payment,
      paymentAttemptId: payment,
      orderId: '101',
      transactionId: 'FIXTURE-101',
    },
    database,
  );
  await expect(clearReviewedDraft(draft, proof, database)).rejects.toThrow('confirmed payment');
  expect(await database.completedSales.count()).toBe(1);
  const second = await prepared();
  const cleared = await clearReviewedDraft(second.draft, second.proof, database);
  await expect(
    clearReviewedDraft(
      second.draft,
      { ...second.proof, operationId: crypto.randomUUID() },
      database,
    ),
  ).rejects.toThrow('different clear');
  expect(await database.drafts.get(['1', cleared.replacementDraftId])).toBeDefined();
});
it('rolls back the marker, deletion and replacement together if replacement creation fails', async () => {
  const { draft, proof } = await prepared();
  const collision = crypto.randomUUID();
  await database.drafts.put({
    ...draft,
    id: collision,
    lines: [{ ...draft.lines[0]!, quantity: 9 }],
  });
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(collision);
  await expect(clearReviewedDraft(draft, proof, database)).rejects.toThrow();
  expect(await database.drafts.get(['1', draft.id])).toEqual(draft);
  expect(await database.drafts.get(['1', collision])).toMatchObject({ lines: [{ quantity: 9 }] });
  expect(await database.clearedDrafts.count()).toBe(0);
  expect(await database.reviewSnapshots.count()).toBe(1);
});
it('does not clear another operator’s matching draft or trust caller-replaced snapshot contents', async () => {
  const { draft, proof } = await prepared();
  await database.drafts.put({ ...draft, ownerId: '2' });
  await database.drafts.update(['1', draft.id], { lines: [{ ...draft.lines[0]!, quantity: 2 }] });
  const result = await clearReviewedDraft(
    { ...draft, lines: [{ ...draft.lines[0]!, quantity: 999 }] },
    proof,
    database,
  );
  expect(await database.drafts.get(['1', result.replacementDraftId])).toMatchObject({
    lines: [{ quantity: 2 }],
  });
  expect(await database.drafts.get(['2', draft.id])).toBeDefined();
});
