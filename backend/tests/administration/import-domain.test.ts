import { describe, expect, it } from 'vitest';
import {
  parseStockImport,
  stockCsv,
  stockImportHeaders,
  stockTemplateRows,
} from '../../src/modules/administration/import-domain.js';
import { goldenStdout } from '../golden/load.js';

const oracle = <T>(operation: string, cases: unknown[]): T[] =>
  JSON.parse(
    goldenStdout('administration', 'import-domain', JSON.stringify({ operation, cases })),
  ) as T[];
describe('inventory CSV source and validation boundaries', () => {
  it('preserves the exact source template and header-based quoted-field reading', () => {
    expect(stockTemplateRows).toEqual(oracle<string[][]>('stock-csv-template', [{}])[0]);
    const header = [...stockImportHeaders].reverse(),
      values = ['001_234', '+1', '', '', '1', '0'];
    const csv = stockCsv([header, [...values].reverse()]);
    const source = oracle<Record<string, string>[]>('stock-csv-reader', [{ csv }])[0]!;
    const parsed = parseStockImport(csv);
    expect(parsed[0]?.cells).toEqual(stockImportHeaders.map((name) => source[0]![name]));
    expect(parsed[0]?.command).toEqual({
      productId: '1234',
      storeId: '1',
      movement: 'none',
      quantity: 0,
      available: true,
      archived: false,
    });
    expect(parseStockImport('\uFEFF' + csv)[0]?.command).toEqual(parsed[0]?.command);
  });
  it('records the unreachable source unhold branch and explicitly corrects its movement', () => {
    expect(oracle('stock-csv-branches', [{ isHold: '0', quantity: '2' }])).toEqual([
      { hold: true, unhold: false },
    ]);
    const csv = stockCsv([stockImportHeaders, ['1234', '1', '0', '2', '', '']]);
    expect(parseStockImport(csv)[0]?.command?.movement).toBe('unhold');
    for (const [flag, quantity] of [
      ['1', '-2'],
      ['0', '0'],
      ['', '2'],
      ['1', ''],
      ['2', '1'],
    ])
      expect(
        parseStockImport(stockCsv([stockImportHeaders, ['1234', '1', flag!, quantity!, '', '']]))[0]
          ?.command,
      ).toBeNull();
  });
  it('rejects malformed/oversized files and preserves invalid rows without executable spreadsheet cells', () => {
    for (const csv of [
      'SkuId,StoreId\r\n1,1\r\n',
      stockCsv([stockImportHeaders, ['1', '1', '', '', '', '', 'extra']]),
      stockCsv([stockImportHeaders, ['1'.repeat(129), '1', '', '', '', '']]),
      stockCsv([
        stockImportHeaders,
        ...Array.from({ length: 5001 }, () => ['1', '1', '', '', '1', '0']),
      ]),
    ])
      expect(() => parseStockImport(csv)).toThrow();
    const cells = ['=HYPERLINK("https://example.invalid")', '1', '', '', '1', '0'];
    const parsed = parseStockImport(stockCsv([stockImportHeaders, cells]));
    expect(parsed[0]?.errorCode).toBe('INVENTORY_CSV_ROW_INVALID');
    const exported = stockCsv([stockImportHeaders, cells], true);
    expect(
      oracle<Record<string, string>[]>('stock-csv-reader', [{ csv: exported }])[0]?.[0]?.SkuId,
    ).toBe("'" + cells[0]);
  });
});
