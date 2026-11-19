import { describe, expect, it } from 'vitest';
import {
  csvUploadInput,
  pythonCsv,
  pythonCsvRows,
  pythonDictRows,
  pythonInt,
  pythonJsonDumps,
  pythonRepr,
  templateInput,
  templates,
  PythonError,
} from '../../src/modules/administration/import-domain.js';
import { goldenStdout } from '../golden/load.js';

const oracle = <T>(operation: string, cases: unknown[]): T[] =>
  JSON.parse(
    goldenStdout('administration', 'import-domain', JSON.stringify({ operation, cases })),
  ) as T[];
const stockHeaders = ['SkuId', 'StoreId', 'IsHold', 'Hold/UnholdQty', 'IsAvailable', 'IsDelete'];
/** The quote-everything CSV the captured oracle input was built with. */
const quotedCsv = (rows: string[][]) =>
  rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\r\n') +
  '\r\n';

describe('inventory CSV source semantics', () => {
  it('keeps the exact source templates and their csv.writer encoding', () => {
    expect(templates.PRODUCT_STOCK_CSV.rows).toEqual(
      oracle<string[][]>('stock-csv-template', [{}])[0],
    );
    expect(pythonCsv(templates.PRODUCT_STORE_CSV.rows)).toBe(
      'SkuId,StoreId,IsActive\r\n' +
        'Enter only parent product ids (variants product ids are not allowed),For store ids please refer instructions on the store bulk upload page,1=>Active and 0=>Delete\r\n' +
        '1234,1,1\r\n',
    );
    expect(pythonCsv([['a,b', 'c"d', 'plain']])).toBe('"a,b","c""d",plain\r\n');
  });
  it('reads records by header like csv.DictReader, keeping raw cell text', () => {
    const header = [...stockHeaders].reverse(),
      values = ['001_234', '+1', '', '', '1', '0'];
    const csv = quotedCsv([header, [...values].reverse()]);
    const source = oracle<Record<string, string>[]>('stock-csv-reader', [{ csv }])[0]!;
    const { records, error } = pythonDictRows(csv);
    expect(error).toBeNull();
    expect(Object.fromEntries(records[0]!)).toEqual(source[0]);
    expect(pythonInt(records[0]!.get('SkuId')!)).toBe(1234n);
    expect(pythonInt(records[0]!.get('StoreId')!)).toBe(1n);
  });
  it('accepts only the stock upload; the product-store upload route is deleted', () => {
    const body = { name: 'upload.csv', csv: 'SkuId,StoreId,IsActive\n' };
    expect(csvUploadInput.safeParse({ ...body, type: 'PRODUCT_STORE_CSV' }).success).toBe(false);
    expect(csvUploadInput.safeParse({ ...body, type: 'PRODUCT_STOCK_CSV' }).success).toBe(true);
    expect(templateInput.safeParse({ type: 'PRODUCT_STORE_CSV' }).success).toBe(false);
  });
  it('records that legacy IsHold=0 enters the hold branch (the rewrite unholds: approved divergence)', () => {
    expect(oracle('stock-csv-branches', [{ isHold: '0', quantity: '2' }])).toEqual([
      { hold: true, unhold: false },
    ]);
  });
  // Expected values below were produced by CPython's csv/int/json modules on the same inputs.
  it('parses lines like Python csv.reader over readlines()', () => {
    const text = 'SkuId,StoreId\r\n\r\n1,"a,b"\n2,"multi\nline"\n" q ""x""",3,extra\n4\n\n5,6';
    expect(pythonCsvRows(text)).toEqual({
      rows: [
        ['SkuId', 'StoreId'],
        [],
        ['1', 'a,b'],
        ['2', 'multi\nline'],
        [' q "x"', '3', 'extra'],
        ['4'],
        [],
        ['5', '6'],
      ],
      error: null,
    });
    expect(pythonDictRows(text).records.map((record) => Object.fromEntries(record))).toEqual([
      { SkuId: '1', StoreId: 'a,b' },
      { SkuId: '2', StoreId: 'multi\nline' },
      { SkuId: ' q "x"', StoreId: '3' },
      { SkuId: '4', StoreId: null },
      { SkuId: '5', StoreId: '6' },
    ]);
    expect(pythonCsvRows('"ab"c,d\n"open\nmore').rows).toEqual([['abc', 'd'], ['open\nmore']]);
    expect(pythonCsvRows('x,"open').rows).toEqual([['x', 'open']]);
    expect(pythonCsvRows('x,').rows).toEqual([['x', '']]);
    expect(pythonCsvRows('a,b\r\n \n,,\n').rows).toEqual([['a', 'b'], [' '], ['', '', '']]);
    // A BOM stays part of the first header, so `row['SkuId']` fails in the source.
    expect([...pythonDictRows('﻿SkuId,StoreId\n1,2').records[0]!.keys()]).toEqual([
      '﻿SkuId',
      'StoreId',
    ]);
    const broken = pythonDictRows('a,b\n1,2\r3,4\n5,6\n');
    expect(broken.records.map((record) => Object.fromEntries(record))).toEqual([]);
    expect(broken.error).toBeInstanceOf(PythonError);
    const late = pythonDictRows('a,b\n1,2\n3,4\r5,6\n');
    expect(late.records).toHaveLength(1);
    expect(late.error).toBeInstanceOf(PythonError);
  });
  it('converts cells and reports failures with Python int() messages', () => {
    expect(pythonInt(' 1_0 ')).toBe(10n);
    expect(pythonInt('-007')).toBe(-7n);
    expect(pythonInt('99999999999999999999')).toBe(99999999999999999999n);
    for (const [value, message] of [
      ['abc', "invalid literal for int() with base 10: 'abc'"],
      ['', "invalid literal for int() with base 10: ''"],
      ["it's", 'invalid literal for int() with base 10: "it\'s"'],
      ['x\'y"z', "invalid literal for int() with base 10: 'x\\'y\"z'"],
      ['tab\there', "invalid literal for int() with base 10: 'tab\\there'"],
      ['1.0', "invalid literal for int() with base 10: '1.0'"],
      ['1__0', "invalid literal for int() with base 10: '1__0'"],
    ] as const)
      expect(() => pythonInt(value)).toThrow(message);
    expect(() => pythonInt(null)).toThrow(
      "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'",
    );
    expect(pythonRepr('ü')).toBe("'ü'");
  });
  it('serializes failed_data exactly as json.dumps', () => {
    expect(
      pythonJsonDumps([
        {
          data: { SkuId: 'ü☃', StoreId: null, x: 'a"b\\c\n\u007f' },
          message: 'm',
          other_error: 'e',
        },
      ]),
    ).toBe(
      '[{"data": {"SkuId": "\\u00fc\\u2603", "StoreId": null, "x": "a\\"b\\\\c\\n\\u007f"}, "message": "m", "other_error": "e"}]',
    );
    expect(pythonJsonDumps([])).toBe('[]');
  });
  it('accepts only .csv uploads of a known type within the request bound', () => {
    const valid = { type: 'PRODUCT_STOCK_CSV', name: 'stock.csv', csv: 'SkuId\n1' };
    expect(csvUploadInput.parse(valid)).toEqual(valid);
    for (const input of [
      { ...valid, name: 'stock.CSV' },
      { ...valid, name: 'stock.txt' },
      { ...valid, type: 'OFFLINE_ORDER_PUNCH_IN_CSV' },
      { ...valid, csv: 'x'.repeat(256 * 1024 + 1) },
      { ...valid, extra: true },
    ])
      expect(csvUploadInput.safeParse(input).success).toBe(false);
  });
});
