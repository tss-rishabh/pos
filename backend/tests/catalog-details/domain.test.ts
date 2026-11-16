import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  sourcePageStart,
  sourceProductImages,
  sourcePosUserFullName,
  sourceStockDelta,
} from '../../src/modules/catalog-details/domain.js';
import {
  auditSearchInput,
  productSearchInput,
} from '../../src/modules/catalog-details/contracts.js';
describe('source inventory/catalog reducers', () => {
  it('matches the actual Python stock delta helper, including dictionary insertion order and mixed roots', () => {
    const cases = [
      ['3', '9'],
      ['8', '-2'],
      ['{"2":6,"1":99}', '{"1":11,"2":100}'],
      ['{"S":3,"L":10}', '{"L":7,"S":20}'],
      ['{}', '{"L":1}'],
      ['{"a":1.25}', '{"a":4.1}'],
      ['true', 'false'],
      ['1.0', '3.0'],
      ['[1]', '[2]'],
      ['null', 'null'],
      ['{"a":false}', '{"b":true}'],
      ['{"a":9007199254740993}', '{"a":9007199254740994}'],
      ['{"2":1,"a":0,"2":9}', '{"1":3,"a":{"2":99},"1":10}'],
    ];
    const expected: unknown = JSON.parse(
      execFileSync('python3', ['tools/catalog-details/source-oracle.py'], {
        input: JSON.stringify({ kind: 'product', mode: 'delta', cases }),
        encoding: 'utf8',
      }),
    );
    expect(cases.map(([a, b]) => sourceStockDelta(a!, b!))).toEqual(expected);
    expect(sourceStockDelta('9007199254740993', '9007199254740995')).toBe(2);
    expect(sourceStockDelta('0', '9007199254740995')).toBe('9007199254740995');
    expect(sourcePosUserFullName('\t Fixture ', 'Operator\u0085')).toBe('Fixture  Operator');
    expect(() => sourceStockDelta('broken', '1')).toThrow('invalid stock value');
    expect(() => sourceStockDelta('{"a":null}', '{"a":2}')).toThrow('invalid stock value');
  });
  it('preserves invalid/out-of-range source page reset, bounds inputs and restricts image destinations', () => {
    expect(sourcePageStart(25, 25, 40)).toBe(25);
    expect(sourcePageStart(40, 25, 100)).toBe(0);
    expect(sourcePageStart(100, 25, 40)).toBe(0);
    expect(productSearchInput.safeParse({ sort: 'id; DROP TABLE products' }).success).toBe(false);
    expect(productSearchInput.safeParse({ length: 501 }).success).toBe(false);
    expect(
      auditSearchInput.safeParse({ from: '2026-11-40T00:00:00', to: '2026-11-16T00:00:00' })
        .success,
    ).toBe(false);
    expect(
      sourceProductImages(
        '{"male":["blue shirt.jpg","../evil","x?redirect=evil","a\\\\b"],"female":["front/one.jpg"]}',
      ),
    ).toEqual({
      male: [
        'https://prod-img.thesouledstore.com/public/theSoul/uploads/catalog/product/blue%20shirt.jpg',
      ],
      female: [
        'https://prod-img.thesouledstore.com/public/theSoul/uploads/catalog/product/front/one.jpg',
      ],
    });
  });
});
