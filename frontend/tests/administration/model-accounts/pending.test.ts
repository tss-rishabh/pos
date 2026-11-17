import { describe, expect, it } from 'vitest';
import {
  pendingAccounts,
  savePendingAccount,
  removePendingAccount,
} from '../../../src/pages/administration/model-accounts/pending';
import { matchingAccount } from '../../../src/pages/administration/model-accounts/api';
class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
const operationId = '10000000-0000-4000-8000-000000000001';
describe('secret-free model-account recovery evidence', () => {
  it('stores only strict owner/UUID/time metadata, deduplicates and isolates owner namespaces', () => {
    const storage = new MemoryStorage();
    savePendingAccount('1', operationId, storage);
    savePendingAccount('1', operationId, storage);
    expect(storage.length).toBe(1);
    expect(Object.keys(pendingAccounts('1', storage)[0]!)).toEqual([
      'ownerId',
      'operationId',
      'createdAt',
    ]);
    expect(pendingAccounts('2', storage)).toEqual([]);
    removePendingAccount('2', operationId, storage);
    expect(storage.length).toBe(1);
    removePendingAccount('1', operationId, storage);
    expect(storage.length).toBe(0);
  });
  it('refuses extra credential fields, malformed original IDs and unavailable persistence', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'pos-model-account-v1:1:' + operationId,
      JSON.stringify({ ownerId: '1', operationId, createdAt: 1, password: 'must-not-persist' }),
    );
    expect(() => pendingAccounts('1', storage)).toThrow();
    storage.clear();
    expect(() => savePendingAccount('1', 'malformed', storage)).toThrow();
    storage.setItem = () => {
      throw new Error('denied');
    };
    expect(() => savePendingAccount('1', operationId, storage)).toThrow();
  });
  it('rejects mismatched actor/original-operation receipts before pending metadata can be erased', () => {
    const result = {
      id: '9007199254740993',
      operationId,
      actorId: '1',
      status: 'success' as const,
      message: 'Administrative account created.' as const,
    };
    expect(matchingAccount(result, '1', operationId)).toBe(result);
    expect(() => matchingAccount(result, '2', operationId)).toThrow();
    expect(() => matchingAccount(result, '1', '10000000-0000-4000-8000-000000000002')).toThrow();
  });
});
