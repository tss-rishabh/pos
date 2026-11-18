import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exchangeCell, type ExchangeCellFacts } from '../../src/pages/returns/exchange-cell';

interface Golden {
  base: ExchangeCellFacts;
  cases: { name: string; facts: Partial<ExchangeCellFacts>; expected: unknown }[];
}
// The same hand-derived legacy template table the backend branch selector is tested against.
const golden = JSON.parse(
  readFileSync(
    new URL('../../../backend/tests/golden/checkout/exchange-cell-guards.json', import.meta.url),
    'utf8',
  ),
) as Golden;

describe('returns UI return/exchange cell branches', () => {
  for (const value of golden.cases)
    it(value.name, () => {
      expect(exchangeCell({ ...golden.base, ...value.facts })).toEqual(value.expected);
    });
  it('stays identical to the backend selector', () => {
    const strip = (source: string) =>
      source.slice(source.indexOf('export interface EligibilityEntry'));
    expect(
      strip(
        readFileSync(new URL('../../src/pages/returns/exchange-cell.ts', import.meta.url), 'utf8'),
      ),
    ).toBe(
      strip(
        readFileSync(
          new URL(
            '../../../backend/src/modules/checkout/return-workflow/exchange-cell.ts',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    );
  });
});
