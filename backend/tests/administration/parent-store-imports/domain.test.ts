import { describe, expect, it } from 'vitest';
import {
  parseParentStoreImport,
  parentStoreTemplate,
} from '../../../src/modules/administration/parent-store-imports/domain.js';
import { stockCsv } from '../../../src/modules/administration/import-domain.js';

describe('three-column parent/store CSV contract', () => {
  it('canonicalizes Python integer syntax without rounding full-width identifiers', () => {
    const [row] = parseParentStoreImport(
      'StoreId,IsActive,SkuId\r\n +0_1 ,+01,9007199254740993\r\n',
    );
    expect(row?.command).toEqual({
      kind: 'parent-store',
      productId: '9007199254740993',
      storeId: '1',
      active: true,
    });
    expect(row?.cells).toEqual(['9007199254740993', ' +0_1 ', '+01']);
  });
  it('retains source parameter and parsing messages for independent failed rows', () => {
    const rows = parseParentStoreImport(
      'SkuId,StoreId,IsActive\n0,1,1\n20,0,1\n20,1,2\ntext,1,1\n20,1,1.0\n',
    );
    expect(rows.map((row) => row.message)).toEqual([
      'Required parameters are missing.',
      'Required parameters are missing.',
      'Required parameters are missing.',
      'Error while traversing csv data.',
      'Error while traversing csv data.',
    ]);
  });
  it('rejects every repeated normalized parent/store pair before either destructive row runs', () => {
    const rows = parseParentStoreImport('SkuId,StoreId,IsActive\n20,1,1\n+020,01,0\n20,2,1\n');
    expect(rows.map((row) => row.errorCode)).toEqual([
      'PARENT_STORE_DUPLICATE_PAIR',
      'PARENT_STORE_DUPLICATE_PAIR',
      null,
    ]);
    expect(rows.slice(0, 2).every((row) => row.command === null)).toBe(true);
  });
  it('keeps the exact source sample/instructions and safely serializes formula-looking failure fields', () => {
    expect(stockCsv(parentStoreTemplate)).toContain('"SkuId","StoreId","IsActive"');
    expect(stockCsv(parentStoreTemplate)).toContain('1=>Active and 0=>Delete');
    expect(parseParentStoreImport(stockCsv(parentStoreTemplate))[0]?.command).toBeNull();
    expect(stockCsv([['=1', '+2', '@3']], true)).toBe('"\'=1","\'+2","\'@3"\r\n');
  });
  it('bounds files, record count, cell width, malformed CSV and exact headers', () => {
    for (const input of [
      'SkuId,StoreId,IsHold\n1,1,1',
      'SkuId,SkuId,IsActive\n1,1,1',
      'SkuId,StoreId,IsActive\n"a,1,1',
      'SkuId,StoreId,IsActive\n' + '1,1,1\n'.repeat(5001),
      'SkuId,StoreId,IsActive\n' + 'a'.repeat(129) + ',1,1',
      ' '.repeat(262145),
    ])
      expect(() => parseParentStoreImport(input)).toThrow();
  });
});
