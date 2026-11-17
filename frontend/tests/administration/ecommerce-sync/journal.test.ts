import { describe, expect, it } from 'vitest';
import {
  readEcommerceJournal,
  saveEcommerceJournal,
} from '../../../src/pages/administration/ecommerce-sync/journal';
const operationId = 'a06239bd-8e93-4fd7-a34d-75e344b9c18b';
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] || null,
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
describe('ecommerce original-operation journal', () => {
  it('survives reload with the exact original input and keeps actor/store namespaces separate', () => {
    const db = storage(),
      row = {
        ownerId: '1',
        storeId: '2',
        action: {
          kind: 'change' as const,
          input: { operationId, expectedVersion: 'a'.repeat(64), threshold: 7, active: false },
        },
        syncId: null,
      };
    saveEcommerceJournal(row, db);
    expect(readEcommerceJournal('1', '2', db)).toEqual(row);
    expect(readEcommerceJournal('3', '2', db).action).toBeNull();
    expect(readEcommerceJournal('1', '3', db).action).toBeNull();
  });
  it('refuses corrupt/foreign or unavailable storage before a replacement can be sent', () => {
    const db = storage();
    db.setItem('pos-ecommerce-sync-v1:1:2', '{"ownerId":"3"}');
    expect(() => readEcommerceJournal('1', '2', db)).toThrow('Saved settings requests');
    db.setItem = () => {
      throw new Error('private-browser-error');
    };
    expect(() =>
      saveEcommerceJournal({ ownerId: '1', storeId: '2', action: null, syncId: null }, db),
    ).toThrow('Saved settings requests');
  });
});
