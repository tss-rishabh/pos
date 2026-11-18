import { describe, expect, it } from 'vitest';
import { catalogWorkbook } from '../../src/pages/catalog/workbook';
import { goldenStdout } from '../golden/load';
describe('offline catalog Excel export', () => {
  it('can be decoded by independent ZIP/XML readers, preserving long identifiers and formula-like literal cells', async () => {
    const blob = catalogWorkbook(
      ['ID', 'Product', 'Price'],
      [
        ['9007199254740993', '=HYPERLINK("https://invalid.test")', '10.00'],
        ['2', 'blue <cotton> & "quote"\u0000', null],
      ],
    );
    const decoded: unknown = JSON.parse(
      goldenStdout('catalog', 'workbook', Buffer.from(await blob.arrayBuffer())),
    );
    expect(decoded).toMatchObject({
      rows: [
        ['ID', 'Product', 'Price'],
        ['9007199254740993', '=HYPERLINK("https://invalid.test")', '10.00'],
        ['2', 'blue <cotton> & "quote"', ''],
      ],
      formulas: 0,
    });
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
});
