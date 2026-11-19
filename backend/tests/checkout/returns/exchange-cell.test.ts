import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cellOffers,
  exchangeCell,
  exchangeRefusal,
  forceReturnRefusal,
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

describe('S35 server guards agree with the template branches', () => {
  const offeredBy = (facts: ExchangeCellFacts) => exchangeCell(facts);
  it('refuses force return exactly where show.html shows no force-return button', () => {
    for (const value of golden.cases) {
      const facts = { ...golden.base, ...value.facts };
      if (cellOffers(offeredBy(facts), 'force-return'))
        expect(forceReturnRefusal(facts), value.name).toBeNull();
    }
    const store = { variant: 'store' as const, lineStatus: 'DELIVERED', productType: 1 };
    expect(forceReturnRefusal(store)).toBeNull();
    for (const facts of [
      { ...store, productType: 8 },
      { ...store, lineStatus: 'PLACED' },
      { ...store, lineStatus: 'PRODUCT_RETURNED' },
      { ...store, variant: 'online' as const },
    ])
      expect(forceReturnRefusal(facts)).toEqual({
        status: 409,
        code: 'RETURN_NOT_APPLICABLE',
        message: 'Not applicable for return',
      });
  });
  it('refuses an exchange or retry exactly where no cell offers it for type 8 or a disabled flag', () => {
    for (const value of golden.cases) {
      const facts = { ...golden.base, ...value.facts },
        cell = offeredBy(facts),
        merged = cell.branch === 'merged';
      if (cellOffers(cell, 'exchange'))
        expect(exchangeRefusal({ ...facts, retry: false, merged }), value.name).toBeNull();
      if (cellOffers(cell, 'retry-exchange'))
        expect(exchangeRefusal({ ...facts, retry: true, merged: null }), value.name).toBeNull();
    }
    const base = { variant: 'online' as const, productType: 1, exchangeFeatureEnabled: true };
    const typeEight = {
      status: 409,
      code: 'EXCHANGE_NOT_APPLICABLE',
      message: 'Not Applicable For Exchange',
    };
    const disabled = {
      status: 403,
      code: 'EXCHANGE_NOT_ENABLED',
      message: 'Not applicable for exchange',
    };
    expect(exchangeRefusal({ ...base, retry: false, merged: null })).toBeNull();
    expect(
      exchangeRefusal({ ...base, exchangeFeatureEnabled: false, retry: true, merged: null }),
    ).toEqual(disabled);
    expect(
      exchangeRefusal({ ...base, variant: 'store', productType: 8, retry: true, merged: true }),
    ).toEqual(typeEight);
    // Online cells: type 8 is refused outside the merged cell, never for a retry.
    expect(exchangeRefusal({ ...base, productType: 8, retry: false, merged: false })).toEqual(
      typeEight,
    );
    expect(exchangeRefusal({ ...base, productType: 8, retry: false, merged: true })).toBeNull();
    expect(exchangeRefusal({ ...base, productType: 8, retry: true, merged: null })).toBeNull();
  });
});
