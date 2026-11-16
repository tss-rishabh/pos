import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkError, setRequestOperator } from '../../src/api/client';
import {
  completeMaintenanceMarker,
  pendingMaintenanceCommand,
  submitMaintenanceCommand,
  type MaintenanceAction,
} from '../../src/pages/catalog/maintenance-commands';
import type { MaintenanceReceipt } from '../../src/pages/catalog/maintenance-contracts';
class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) || null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
const receipt = (id: string): MaintenanceReceipt => ({
  id,
  kind: 'inventory-pull',
  state: 'PENDING',
  metadata: {
    requestedCount: 1,
    uniqueRequestedCount: 1,
    matchedCount: 1,
    mode: 'csv',
    parentRowsChanged: 0,
    imageReset: false,
    barcodeRowsChanged: 0,
  },
  localApplied: false,
  createdAt: '2026-11-16 10:00:00.000',
  updatedAt: '2026-11-16 10:00:00.000',
  errorCode: null,
  deliveries: [],
});
describe('durable owner-bound catalog maintenance submissions', () => {
  beforeEach(() => setRequestOperator('1'));
  afterEach(() => {
    setRequestOperator(null);
    vi.restoreAllMocks();
  });
  it('keeps the original UUID across uncertain submission and persists no raw CSV or filenames', async () => {
    const storage = new MemoryStorage(),
      action: MaintenanceAction = {
        kind: 'inventory-pull',
        input: { mode: 'csv', filename: 'fixture.csv', csv: 'sku\n11\n' },
      },
      ids: string[] = [];
    await expect(
      submitMaintenanceCommand('1', action, storage, async (id) => {
        ids.push(id);
        throw new NetworkError();
      }),
    ).rejects.toThrow('connect');
    const saved = pendingMaintenanceCommand('1', 'inventory-pull', storage)!;
    expect([...storage.values.values()].join('')).not.toContain('fixture.csv');
    expect([...storage.values.values()].join('')).not.toContain('sku\\n');
    expect(Object.keys(JSON.parse([...storage.values.values()][0]!) as object).sort()).toEqual([
      'hash',
      'id',
    ]);
    const result = await submitMaintenanceCommand('1', action, storage, async (id) => {
      ids.push(id);
      return receipt(id);
    });
    expect(ids).toEqual([saved.id, saved.id]);
    await expect(
      submitMaintenanceCommand(
        '1',
        { kind: 'inventory-pull', input: { mode: 'manual', skus: '20' } },
        storage,
        async (id) => receipt(id),
      ),
    ).rejects.toThrow('previous maintenance');
    completeMaintenanceMarker('1', { ...result, state: 'SUCCEEDED' }, storage);
    expect(pendingMaintenanceCommand('1', 'inventory-pull', storage)).toBeNull();
  });
  it('does not recreate an old owner marker after logout during hashing', async () => {
    const storage = new MemoryStorage();
    let release: ((value: ArrayBuffer) => void) | undefined;
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const send = vi.fn(async (id: string) => receipt(id));
    const pending = submitMaintenanceCommand(
      '1',
      { kind: 'inventory-pull', input: { mode: 'manual', skus: '11' } },
      storage,
      send,
    );
    expect(release).toBeTypeOf('function');
    setRequestOperator('2');
    release?.(new Uint8Array(32).buffer);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(storage.values.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
