import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db, type LocalDraft } from '../../src/offline/database';
import { commitDraftQuantity, parseDraftQuantity } from '../../src/pages/counter-catalog/quantity';
const scope = {
  ownerId: 'quantity-owner',
  storeId: '2',
  counterId: '3',
  draftId: 'quantity-draft',
};
const draft: LocalDraft = {
  id: scope.draftId,
  ...scope,
  customerId: null,
  version: 0,
  createdAt: 1,
  updatedAt: 1,
  lines: [
    {
      productId: '9007199254740993',
      name: 'Quantity fixture',
      barcode: '123',
      unitPrice: '25.49',
      quantity: 7,
    },
  ],
};
beforeEach(async () => {
  await db.drafts.clear();
  await db.drafts.put(draft);
});
it('parses exact whole quantity without converting invalid/unsafe inputs', () => {
  expect(parseDraftQuantity('000')).toBe(0);
  expect(parseDraftQuantity('999')).toBe(999);
  for (const input of ['', '-1', '1.5', '1e2', '1000', '9999999999999999999', ' 1'])
    expect(() => parseDraftQuantity(input)).toThrow();
});
it('sets quantity directly and explicitly zero removes only the matching line', async () => {
  await commitDraftQuantity(
    scope,
    '9007199254740993',
    25,
    new AbortController().signal,
    () => true,
  );
  expect((await db.drafts.get([scope.ownerId, scope.draftId]))?.lines[0]?.quantity).toBe(25);
  await commitDraftQuantity(scope, '9007199254740993', 0, new AbortController().signal, () => true);
  expect((await db.drafts.get([scope.ownerId, scope.draftId]))?.lines).toEqual([]);
});
it('rejects invalid values and changed/aborted actor or workspace without a draft write', async () => {
  for (const quantity of [-1, 1.5, 1000, NaN, Infinity])
    await expect(
      commitDraftQuantity(
        scope,
        '9007199254740993',
        quantity,
        new AbortController().signal,
        () => true,
      ),
    ).rejects.toThrow();
  await expect(
    commitDraftQuantity(scope, '9007199254740993', 2, AbortSignal.abort(), () => true),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await expect(
    commitDraftQuantity(scope, '9007199254740993', 2, new AbortController().signal, () => false),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect((await db.drafts.get([scope.ownerId, scope.draftId]))?.lines).toEqual(draft.lines);
});
it('rolls back an in-transaction sale change and does not restore a removed line', async () => {
  let checks = 0;
  await expect(
    commitDraftQuantity(
      scope,
      '9007199254740993',
      2,
      new AbortController().signal,
      () => ++checks < 3,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect((await db.drafts.get([scope.ownerId, scope.draftId]))?.lines).toEqual(draft.lines);
  await db.drafts.put({ ...draft, lines: [] });
  await commitDraftQuantity(scope, '9007199254740993', 2, new AbortController().signal, () => true);
  expect((await db.drafts.get([scope.ownerId, scope.draftId]))?.lines).toEqual([]);
});
