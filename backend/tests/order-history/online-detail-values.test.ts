import { describe, expect, it } from 'vitest';
import {
  detailDecimal,
  detailWallet,
  detailPaymentEntries,
  safeTrackingUrl,
} from '../../src/modules/order-history/online-detail/values.js';
import { nextStoreIds } from '../../src/modules/order-history/online-detail/authority.js';
import { onlineDetailSelection } from '../../src/modules/order-history/online-detail/contracts.js';

describe('online detail input and safe legacy values', () => {
  it('retains flat original payment entries without executing legacy text', () => {
    expect(
      detailPaymentEntries(
        `{'Cash': 25.49, 'TSS Money': 0.01, 'unused': None, 'note': 'kept value'}`,
      ),
    ).toEqual([
      { method: 'Cash', value: '25.49' },
      { method: 'TSS Money', value: '0.01' },
      { method: 'unused', value: null },
      { method: 'note', value: 'kept value' },
    ]);
    expect(detailPaymentEntries('{"Cash":25.49,"flag":false}')).toEqual([
      { method: 'Cash', value: '25.49' },
      { method: 'flag', value: 'false' },
    ]);
    expect(detailPaymentEntries('')).toEqual([]);
    for (const raw of [
      "{'Cash':__import__('os').system('false')}",
      "{'Cash': [1,2]}",
      "{'Cash':{'amount':1}}",
      '{"Cash":1,"Cash":2}',
      '{"Cash":NaN}',
      '{"Cash":1} trailing',
      '{',
    ])
      expect(() => detailPaymentEntries(raw)).toThrow('Complete order details');
  });
  it('keeps exact decimal strings and refuses nonfinite or oversized legacy data', () => {
    expect(detailDecimal('25.4900')).toBe('25.49');
    expect(detailDecimal('0.01')).toBe('0.01');
    for (const [input, expected] of [
      [-0.001, '0.00'],
      [0.49, '0.49'],
      [1.005, '1.01'],
      [25.495, '25.50'],
    ] as const)
      expect(detailWallet(input)).toBe(expected);
    expect(() => detailDecimal(Infinity)).toThrow();
    expect(() => detailDecimal(null)).toThrow();
    expect(() => detailPaymentEntries('x'.repeat(100001))).toThrow();
  });
  it('allows only credential-free HTTPS tracking links and refuses unsafe ownership JSON', () => {
    expect(safeTrackingUrl('https://tracking.example.invalid/track/1')).toBe(
      'https://tracking.example.invalid/track/1',
    );
    for (const raw of [
      'javascript:alert(1)',
      '//external.invalid',
      'https://a:b@example.invalid',
      'https://example.invalid/\\evil',
      'https://example.invalid/\n',
    ])
      expect(safeTrackingUrl(raw)).toBeNull();
    expect(nextStoreIds('["9007199254740993",1,1]')).toEqual(['1', '9007199254740993']);
    expect(() => nextStoreIds('[9007199254740993]')).toThrow();
    expect(() => nextStoreIds('{"store":1}')).toThrow();
  });
  it('requires explicit type and paired dates', () => {
    expect(onlineDetailSelection.parse({ type: 'N' })).toEqual({ type: 'N' });
    for (const input of [
      { type: 'ST' },
      { type: 'N', from: '2026-11-01' },
      { type: 'N', customerId: '7' },
      { type: 'N', intent: 'report' },
    ])
      expect(onlineDetailSelection.safeParse(input).success).toBe(false);
  });
});
