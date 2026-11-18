import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  exchangeCell,
  type ExchangeCellFacts,
} from '../../../src/modules/checkout/return-workflow/exchange-cell.js';

interface Golden {
  base: ExchangeCellFacts;
  cases: { name: string; facts: Partial<ExchangeCellFacts>; expected: unknown }[];
}
const golden = JSON.parse(
  readFileSync(new URL('../../golden/checkout/exchange-cell-guards.json', import.meta.url), 'utf8'),
) as Golden;

describe('legacy return/exchange cell branches (exchange-cell-guards.md section 2)', () => {
  it('covers every template branch', () => {
    const branches = new Set(
      golden.cases.map((value) => (value.expected as { branch: string }).branch),
    );
    expect([...branches].sort()).toEqual(
      [
        'already-exchanged',
        'already-returned',
        'check-in-first',
        'failed-exchange',
        'merged',
        'no-cells',
        'split',
        'store-product-type-8',
      ].sort(),
    );
  });
  for (const value of golden.cases)
    it(value.name, () => {
      expect(exchangeCell({ ...golden.base, ...value.facts })).toEqual(value.expected);
    });
});
