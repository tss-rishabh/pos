import { describe, expect, it } from 'vitest';
import { cashPriceSnapshotSchema } from '../../src/modules/checkout/offline-cash/contracts.js';
import { goldenStdout } from '../golden/load.js';

describe('source-executed private offline cash pricing', () => {
  it('returns the exact strict TypeScript grant pricing contract without coercion', () => {
    // Captured `test_source_pricing.py --snapshot` output over backend-tss-api_v2@2960acb.
    const raw: unknown = JSON.parse(
      goldenStdout('checkout', 'offline-cash-source-pricing.snapshot'),
    );
    const result = cashPriceSnapshotSchema.parse(raw);
    expect(result).toEqual(raw);
    expect(result.products[0]?.quantities.map((row) => row.quantity)).toEqual([1, 2, 3, 5, 20]);
    expect(result.products[0]?.quantities[2]?.mainSubtotalCents).toBe(23738);
    expect(result.products[0]?.cachedStock).toBe(50);
    expect(result.products[1]?.quantities[0]?.unitPrice).toBe('300.0');
    expect(result.lineItemsEnabled).toBe(true);
  });
});
