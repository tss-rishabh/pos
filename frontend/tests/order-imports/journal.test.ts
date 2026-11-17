import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import {
  orderImportInputHash,
  readImportIntent,
  saveImportIntent,
} from '../../src/pages/administration/order-imports/journal';
import type { OrderImportInput } from '../../src/pages/administration/order-imports/client';
describe('CSV import private request recovery', () => {
  const values = new Map<string, string>();
  beforeEach(() => {
    values.clear();
    const storage: Storage = {
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
    setRequestOperator('44');
  });
  afterEach(() => {
    setRequestOperator(null);
    vi.unstubAllGlobals();
  });
  const input: OrderImportInput = {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'offline',
    counters: [{ storeId: '1', counterId: '2' }],
    csv: 'private-customer@example.test,Private imported name',
  };
  it('stores only the owner/scopes/reference and complete-input digest, and refuses a changed retry', async () => {
    const inputHash = await orderImportInputHash(input),
      intent = {
        version: 1 as const,
        operatorId: '44',
        id: input.id,
        kind: input.kind,
        inputHash,
        counters: input.counters,
        storeId: null,
      };
    saveImportIntent(intent);
    expect(readImportIntent('44')).toEqual(intent);
    expect(JSON.stringify([...values.values()])).not.toMatch(
      /private-customer|Private imported name|csv/,
    );
    const changed = await orderImportInputHash({ ...input, csv: input.csv + 'changed' });
    expect(changed).not.toBe(inputHash);
    expect(() => saveImportIntent({ ...intent, inputHash: changed })).toThrow(/original import/);
    expect(
      await orderImportInputHash({ ...input, counters: [{ storeId: '1', counterId: '3' }] }),
    ).not.toBe(inputHash);
  });
  it('refuses a different active operator before reading or overwriting the original reference', async () => {
    const inputHash = await orderImportInputHash(input),
      intent = {
        version: 1 as const,
        operatorId: '44',
        id: input.id,
        kind: input.kind,
        inputHash,
        counters: input.counters,
        storeId: null,
      };
    saveImportIntent(intent);
    const before = [...values.entries()];
    setRequestOperator('45');
    expect(() => readImportIntent('44')).toThrow(/operator changed/);
    expect(() => saveImportIntent(intent)).toThrow(/operator changed/);
    expect([...values.entries()]).toEqual(before);
    expect(readImportIntent('45')).toBeNull();
  });
});
