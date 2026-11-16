import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { PosDatabase, type LocalDraft } from '../src/offline/database';
import { prepareReview } from '../src/offline/review-snapshot';
import { completeSale } from '../src/offline/complete-sale';

const opened: PosDatabase[] = [];
const open = (name = 'review-test-' + crypto.randomUUID()) => {
  const database = new PosDatabase(name);
  opened.push(database);
  return database;
};
afterEach(async () => {
  const names = [...new Set(opened.map((database) => database.name))];
  for (const database of opened) database.close();
  opened.length = 0;
  for (const name of names) await new PosDatabase(name).delete();
});
const draft = (): LocalDraft => ({
  id: crypto.randomUUID(),
  ownerId: '1',
  storeId: '1',
  counterId: '1',
  customerId: null,
  version: 0,
  createdAt: 1,
  updatedAt: 2,
  lines: [{ productId: '1', name: 'Fixture item', barcode: null, unitPrice: '10.00', quantity: 1 }],
});
const receipt = () => {
  const id = crypto.randomUUID();
  return {
    source: 'counter' as const,
    status: 'paid' as const,
    receiptId: id,
    paymentAttemptId: id,
    orderId: '101',
    transactionId: 'fixture-payment-101',
  };
};
it('keeps the original snapshot across database reopen and preserves later unpurchased edits even if a callback supplies the newer cart', async () => {
  const database = open(),
    sale = draft();
  await database.drafts.put(sale);
  await prepareReview(sale, null, database);
  database.close();
  const reopened = open(database.name);
  const changed = { ...sale, updatedAt: 100, lines: [{ ...sale.lines[0]!, quantity: 3 }] };
  await reopened.drafts.put(changed);
  const review = await prepareReview(changed, { draftVersion: sale.updatedAt }, reopened);
  expect(review).toMatchObject({
    changed: true,
    snapshot: { updatedAt: sale.updatedAt, lines: [{ quantity: 1 }] },
  });
  const result = await completeSale(changed, receipt(), reopened);
  expect(result.preservedDraftId).toBeTruthy();
  expect(await reopened.drafts.get(['1', result.preservedDraftId!])).toMatchObject({
    version: 0,
    lines: [{ quantity: 3 }],
  });
  expect(await reopened.reviewSnapshots.count()).toBe(0);
});
it('captures one original under simultaneous first opens from multiple tabs', async () => {
  const first = open(),
    second = open(first.name),
    sale = draft();
  await first.drafts.put(sale);
  const snapshots = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      prepareReview({ ...sale, updatedAt: 200 + index }, null, index % 2 ? first : second),
    ),
  );
  expect(await first.reviewSnapshots.count()).toBe(1);
  expect(snapshots.every((review) => review.snapshot.updatedAt === sale.updatedAt)).toBe(true);
  snapshots[0]!.snapshot.lines[0]!.quantity = 8;
  expect((await prepareReview(sale, null, second)).snapshot.lines[0]!.quantity).toBe(1);
});
it('blocks legacy recovery without original evidence and mismatched recovery versions without deleting carts', async () => {
  const database = open(),
    sale = draft();
  await database.drafts.put(sale);
  await expect(prepareReview(sale, { draftVersion: 1 }, database)).rejects.toThrow(
    'no original saved snapshot',
  );
  expect(await database.reviewSnapshots.count()).toBe(0);
  await expect(completeSale(sale, receipt(), database)).rejects.toThrow(
    'original checkout snapshot',
  );
  await prepareReview(sale, null, database);
  await expect(prepareReview(sale, { draftVersion: 99 }, database)).rejects.toThrow(
    'does not match',
  );
  expect(await database.drafts.get(['1', sale.id])).toEqual(sale);
  expect(await database.completedSales.count()).toBe(0);
});
it('isolates snapshot ownership and rejects a corrupted snapshot before archiving', async () => {
  const database = open(),
    sale = draft();
  await database.drafts.bulkPut([sale, { ...sale, ownerId: '2', lines: [] }]);
  await prepareReview(sale, null, database);
  await database.reviewSnapshots.update(['1', sale.id], { snapshot: { ...sale, ownerId: '2' } });
  await expect(completeSale(sale, receipt(), database)).rejects.toThrow(
    'original checkout snapshot',
  );
  expect(await database.drafts.count()).toBe(2);
  expect(await database.completedSales.count()).toBe(0);
});
