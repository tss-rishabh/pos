import 'fake-indexeddb/auto';
import { afterEach, it, expect } from 'vitest';
import { PosDatabase, type LocalDraft } from '../src/offline/database';
import { completeSale } from '../src/offline/complete-sale';
import { prepareReview } from '../src/offline/review-snapshot';

const database = new PosDatabase('completion-test-' + crypto.randomUUID());
afterEach(async () => {
  await database.drafts.clear();
  await database.operations.clear();
  await database.completedSales.clear();
  await database.reviewSnapshots.clear();
});
const draft = (): LocalDraft => ({
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
const receipt = {
  source: 'counter' as const,
  receiptId: '9713692e-e4a7-4103-8e90-a6e0dd0d54db',
  status: 'paid' as const,
  orderId: '101',
  paymentAttemptId: '9713692e-e4a7-4103-8e90-a6e0dd0d54db',
  transactionId: '1001',
};
it('archives only a confirmed sale and tolerates repeated paid receipts', async () => {
  const sale = draft();
  await database.drafts.put(sale);
  await prepareReview(sale, null, database);
  expect((await completeSale(sale, receipt, database)).alreadyCompleted).toBe(false);
  expect(await database.drafts.count()).toBe(0);
  expect(await database.completedSales.count()).toBe(1);
  expect((await completeSale(sale, receipt, database)).alreadyCompleted).toBe(true);
  await expect(
    completeSale(
      sale,
      {
        ...receipt,
        receiptId: 'a9dd4356-b27e-49f3-b731-18fda28f2894',
        paymentAttemptId: 'a9dd4356-b27e-49f3-b731-18fda28f2894',
      },
      database,
    ),
  ).rejects.toThrow('different confirmed payment');
});
it('preserves edits made during checkout in a new draft with fresh sync identity', async () => {
  const sale = draft();
  await database.drafts.put(sale);
  await prepareReview(sale, null, database);
  await database.drafts.put({ ...sale, lines: [{ ...sale.lines[0]!, quantity: 2 }] });
  const result = await completeSale(sale, receipt, database);
  expect(result.preservedDraftId).not.toBe(sale.id);
  const kept = await database.drafts.get([sale.ownerId, result.preservedDraftId!]);
  expect(kept).toMatchObject({ version: 0, lines: [{ quantity: 2 }] });
  expect(await database.drafts.get([sale.ownerId, sale.id])).toBeUndefined();
});
it('keeps another operator’s matching local draft isolated', async () => {
  const sale = draft();
  await database.drafts.bulkPut([sale, { ...sale, ownerId: '2' }]);
  await prepareReview(sale, null, database);
  await completeSale(sale, receipt, database);
  expect(await database.drafts.get(['2', sale.id])).toBeDefined();
});
it('records actual prepaid order evidence without inventing a counter payment attempt', async () => {
  const sale = draft();
  await database.drafts.put(sale);
  await prepareReview(sale, null, database);
  const operationId = crypto.randomUUID();
  const prepaid = {
    status: 'paid' as const,
    source: 'prepaid' as const,
    orderId: '102',
    receiptId: operationId,
    checkoutId: crypto.randomUUID(),
    checkoutOperationId: operationId,
    transactionId: 'prepaid-order-102',
  };
  await completeSale(sale, prepaid, database);
  const stored = await database.completedSales.get([sale.ownerId, sale.id]);
  expect(stored).toMatchObject({
    source: 'prepaid',
    receiptId: prepaid.receiptId,
    checkoutOperationId: prepaid.checkoutOperationId,
  });
  expect(stored).not.toHaveProperty('paymentAttemptId');
});
