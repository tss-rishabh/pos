import { describe, expect, it } from 'vitest';
import {
  pendingAssignments,
  savePendingAssignment,
  removePendingAssignment,
} from '../../../src/pages/administration/barcodes/pending';
import {
  matchesAssignment,
  type AssignmentReceipt,
} from '../../../src/pages/administration/barcodes/api';

class MemoryStorage implements Storage {
  private rows = new Map<string, string>();
  get length() {
    return this.rows.size;
  }
  clear() {
    this.rows.clear();
  }
  getItem(key: string) {
    return this.rows.get(key) ?? null;
  }
  key(index: number) {
    return [...this.rows.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.rows.delete(key);
  }
  setItem(key: string, value: string) {
    this.rows.set(key, value);
  }
}
const input = {
  operationId: '94373ef6-4c27-491f-9b1c-2524ff4d28c3',
  productId: '9007199254740993',
  barcode: '9007199254740995',
};
describe('nonfinancial barcode recovery journal', () => {
  it('keeps immutable owner-bound original IDs across reloads and independent tab actions', () => {
    const storage = new MemoryStorage();
    savePendingAssignment('1', input, storage);
    savePendingAssignment(
      '1',
      { ...input, operationId: '68960e0f-998b-4274-bc5d-e9cd0ea9cb57' },
      storage,
    );
    savePendingAssignment('2', input, storage);
    expect(pendingAssignments('1', storage)).toHaveLength(2);
    expect(pendingAssignments('2', storage)).toHaveLength(1);
    removePendingAssignment('1', input, storage);
    expect(pendingAssignments('1', storage)[0]?.input.operationId).toBe(
      '68960e0f-998b-4274-bc5d-e9cd0ea9cb57',
    );
    expect(pendingAssignments('2', storage)[0]?.input).toEqual(input);
  });
  it('refuses changed original payloads and corrupt records without silently erasing pending work', () => {
    const storage = new MemoryStorage();
    savePendingAssignment('1', input, storage);
    expect(() => savePendingAssignment('1', { ...input, barcode: '44' }, storage)).toThrow();
    expect(pendingAssignments('1', storage)[0]?.input).toEqual(input);
    storage.setItem('pos-barcode-assignment-v1:1:' + input.operationId, '{}');
    expect(() => pendingAssignments('1', storage)).toThrow();
    expect(pendingAssignments('2', storage)).toEqual([]);
    expect(storage.length).toBe(1);
  });
  it('requires original actor/product/GTIN/UUID evidence before treating a response as this saved assignment', () => {
    const receipt: AssignmentReceipt = {
      id: input.operationId,
      operatorId: '1',
      productId: input.productId,
      barcode: input.barcode,
      status: 'success',
      code: 'ASSIGNED',
      message: 'Saved',
      barcodeRowId: '8',
      auditId: '9',
      requestId: null,
      createdAt: '2026-06-15 12:00:00',
    };
    expect(matchesAssignment(receipt, '1', input)).toEqual(receipt);
    for (const changed of [
      { operatorId: '2' },
      { barcode: '9' },
      { productId: '2' },
      { id: '68960e0f-998b-4274-bc5d-e9cd0ea9cb57' },
    ])
      expect(() => matchesAssignment({ ...receipt, ...changed }, '1', input)).toThrow();
  });
  it('fails closed when pending evidence cannot be persisted', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error('Synthetic quota failure');
    };
    expect(() => savePendingAssignment('1', input, storage)).toThrow();
    expect(storage.length).toBe(0);
  });
});
