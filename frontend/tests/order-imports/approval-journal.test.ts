import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import {
  clearImportApprovalIntent,
  listImportApprovalIntents,
  readImportApprovalIntent,
  saveImportApprovalIntent,
  orderImportActorScope,
} from '../../src/pages/administration/order-imports/approval-journal';
import { approvalIntent } from './approval-fixtures';
describe('financial approval command journal', () => {
  const values = new Map<string, string>();
  let storage: Storage;
  beforeEach(() => {
    values.clear();
    storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => {
        values.delete(key);
      },
      setItem: (key, value) => {
        values.set(key, value);
      },
    };
    vi.stubGlobal('localStorage', storage);
    const queued = new Map<string, Promise<void>>();
    vi.stubGlobal('navigator', {
      locks: {
        async request(name: string, options: LockOptions, work: () => unknown) {
          const before = queued.get(name) ?? Promise.resolve();
          let release: () => void = () => {};
          queued.set(
            name,
            new Promise<void>((resolve) => {
              release = resolve;
            }),
          );
          await before;
          try {
            options.signal?.throwIfAborted();
            return await work();
          } finally {
            release();
          }
        },
      },
    });
    setRequestOperator('44');
  });
  afterEach(() => {
    setRequestOperator(null);
    vi.unstubAllGlobals();
  });
  it('keeps only owner/job/order-operation/command/reason metadata in a distinct key', async () => {
    const value = approvalIntent();
    await saveImportApprovalIntent(value);
    expect(listImportApprovalIntents('44')).toEqual([value]);
    expect(readImportApprovalIntent('44', value.jobId, value.operationId)).toEqual(value);
    expect([...values.keys()][0]).toMatch(/^pos-order-import-approval:/);
    expect(Object.keys(JSON.parse([...values.values()][0]!) as object).sort()).toEqual([
      'commandId',
      'jobId',
      'operationId',
      'operatorId',
      'reason',
      'version',
    ]);
    expect(JSON.stringify([...values.values()])).not.toMatch(
      /price|amount|csv|email|customer|productId|lineValue/,
    );
  });
  it('preserves independent rows/jobs without replacing the existing file reference', async () => {
    values.set('pos-legacy-order-import:' + JSON.stringify(['44']), 'ORIGINAL_FILE_REFERENCE');
    const first = approvalIntent(),
      second = approvalIntent({
        operationId: '55555555-5555-4555-8555-555555555555',
        commandId: '66666666-6666-4666-8666-666666666666',
      }),
      third = approvalIntent({
        jobId: '77777777-7777-4777-8777-777777777777',
        commandId: '88888888-8888-4888-8888-888888888888',
      });
    for (const value of [first, second, third]) await saveImportApprovalIntent(value);
    expect(listImportApprovalIntents('44')).toHaveLength(3);
    await clearImportApprovalIntent(second);
    expect(listImportApprovalIntents('44')).toHaveLength(2);
    expect(values.get('pos-legacy-order-import:' + JSON.stringify(['44']))).toBe(
      'ORIGINAL_FILE_REFERENCE',
    );
  });
  it('never substitutes a new command or reason for an unresolved request', async () => {
    const value = approvalIntent();
    await saveImportApprovalIntent(value);
    await expect(
      saveImportApprovalIntent({ ...value, commandId: crypto.randomUUID() }),
    ).rejects.toThrow(/original approval/);
    await expect(
      saveImportApprovalIntent({ ...value, reason: 'historical-correction' }),
    ).rejects.toThrow(/original approval/);
    await expect(
      clearImportApprovalIntent({ ...value, commandId: crypto.randomUUID() }),
    ).rejects.toThrow(/request changed/);
    expect(listImportApprovalIntents('44')).toEqual([value]);
  });
  it('blocks before dispatch on storage quota, silent write loss or unreadable storage', async () => {
    const set = storage.setItem,
      get = storage.getItem;
    storage.setItem = () => {
      throw new DOMException('fixture quota');
    };
    await expect(saveImportApprovalIntent(approvalIntent())).rejects.toThrow(/No approval request/);
    storage.setItem = () => {};
    await expect(saveImportApprovalIntent(approvalIntent())).rejects.toThrow(/No approval request/);
    storage.setItem = set;
    storage.getItem = () => {
      throw new DOMException('fixture denial');
    };
    await expect(saveImportApprovalIntent(approvalIntent())).rejects.toThrow(/unreadable/);
    storage.getItem = get;
    expect(values.size).toBe(0);
  });
  it('blocks on corrupt or swapped row references without retiring the pending command', async () => {
    const value = approvalIntent();
    await saveImportApprovalIntent(value);
    const key = [...values.keys()][0]!;
    values.set(key, JSON.stringify({ ...value, operationId: crypto.randomUUID() }));
    expect(() => listImportApprovalIntents('44')).toThrow(/unreadable/);
    await expect(
      saveImportApprovalIntent(approvalIntent({ operationId: crypto.randomUUID() })),
    ).rejects.toThrow(/unreadable/);
    expect(values.size).toBe(1);
  });
  it('does not clear a reference when removal fails or silently retains the original bytes', async () => {
    const value = approvalIntent();
    await saveImportApprovalIntent(value);
    storage.removeItem = () => {};
    await expect(clearImportApprovalIntent(value)).rejects.toThrow(/could not be retired/);
    expect(listImportApprovalIntents('44')).toEqual([value]);
  });
  it('rejects stale actors before reading/writing; role/type/store-scope changes have distinct identities', async () => {
    const value = approvalIntent();
    await saveImportApprovalIntent(value);
    const before = [...values.entries()];
    setRequestOperator('45');
    expect(() => listImportApprovalIntents('44')).toThrow(/operator changed/);
    await expect(saveImportApprovalIntent(value)).rejects.toThrow(/operator changed/);
    await expect(clearImportApprovalIntent(value)).rejects.toThrow(/operator changed/);
    expect(listImportApprovalIntents('45')).toEqual([]);
    expect([...values.entries()]).toEqual(before);
    const actor = {
        id: '44',
        role: 1 as const,
        userType: 1 as const,
        storeIds: ['2', '1'],
        name: 'Fixture',
        email: '',
      },
      scope = orderImportActorScope(actor);
    expect(orderImportActorScope({ ...actor, storeIds: ['1', '2'] })).toBe(scope);
    for (const next of [
      { ...actor, role: 2 as const },
      { ...actor, userType: 2 as const },
      { ...actor, storeIds: ['1'] },
    ])
      expect(orderImportActorScope(next)).not.toBe(scope);
  });
  it('serializes twenty competing row commands so only one durable reference can win', async () => {
    const intents = Array.from({ length: 20 }, () =>
        approvalIntent({ commandId: crypto.randomUUID() }),
      ),
      results = await Promise.allSettled(intents.map((value) => saveImportApprovalIntent(value)));
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(listImportApprovalIntents('44')).toEqual([intents[0]]);
  });
  it('fails closed without browser lock coordination or after owner revocation while queued', async () => {
    vi.stubGlobal('navigator', {});
    await expect(saveImportApprovalIntent(approvalIntent())).rejects.toThrow(
      /coordination is unavailable/,
    );
    expect(values.size).toBe(0);
    vi.stubGlobal('navigator', {
      locks: {
        async request(_name: string, _options: LockOptions, work: () => unknown) {
          setRequestOperator('45');
          return work();
        },
      },
    });
    await expect(saveImportApprovalIntent(approvalIntent())).rejects.toThrow();
    expect(values.size).toBe(0);
  });
});
