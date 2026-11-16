import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { db, type LocalDraft } from '../src/offline/database';
import { queueDraft, replay } from '../src/offline/sync';
import { ApiError } from '../src/api/client';
import type { Draft, DraftMutation } from '../src/api/types';

afterEach(async () => {
  await db.drafts.clear();
  await db.operations.clear();
});
const cart = (): LocalDraft => ({
  id: crypto.randomUUID(),
  ownerId: '1',
  storeId: '1',
  counterId: '1',
  customerId: null,
  lines: [
    { productId: '1001', name: 'Test product', barcode: null, unitPrice: '0.10', quantity: 1 },
  ],
  version: 0,
  updatedAt: Date.now(),
  createdAt: Date.now(),
});
const result = (input: DraftMutation): Draft => ({
  ...input.draft,
  version: input.expectedVersion + 1,
});
describe('offline durability and replay', () => {
  it('keeps operation IDs stable across failures and never sends another operator’s queue', async () => {
    const draft = cart();
    await db.drafts.put(draft);
    await queueDraft(draft);
    let sent = 0;
    await replay('2', async (body) => {
      sent++;
      return result(body);
    });
    expect(sent).toBe(0);
    const before = await db.operations.toArray();
    await replay('1', async () => {
      throw new TypeError('offline');
    });
    const after = await db.operations.toArray();
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.state).toBe('retry');
    await db.operations.update(after[0]!.id, { nextAttemptAt: 0 });
    await replay('1', async (body) => {
      sent++;
      return result(body);
    });
    expect(sent).toBe(1);
    expect(await db.operations.count()).toBe(0);
    expect((await db.drafts.get(['1', draft.id]))?.version).toBe(1);
  });
  it('retains a conflict and preserves local edits after enqueue', async () => {
    const draft = cart();
    await db.drafts.put(draft);
    await queueDraft(draft);
    await db.drafts.update(['1', draft.id], { lines: [{ ...draft.lines[0]!, quantity: 2 }] });
    await replay('1', async () => {
      throw new ApiError(409, 'DRAFT_CONFLICT', 'Another device changed the sale.');
    });
    expect((await db.operations.toArray())[0]!.state).toBe('conflict');
    expect((await db.drafts.get(['1', draft.id]))?.lines[0]?.quantity).toBe(2);
  });
  it('keeps newer local edits when a previously queued snapshot succeeds', async () => {
    const draft = cart();
    await db.drafts.put(draft);
    await queueDraft(draft);
    await db.drafts.update(['1', draft.id], { lines: [{ ...draft.lines[0]!, quantity: 3 }] });
    await replay('1', async (body) => result(body));
    const saved = await db.drafts.get(['1', draft.id]);
    expect(saved?.lines[0]?.quantity).toBe(3);
    expect(saved?.version).toBe(1);
  });
  it('pauses replay if authentication changes', async () => {
    const draft = cart();
    await db.drafts.put(draft);
    await queueDraft(draft);
    await replay('1', async () => {
      throw new ApiError(409, 'OPERATOR_CHANGED', 'Sign back in.');
    });
    expect((await db.operations.toArray())[0]!.state).toBe('pending');
  });
});
