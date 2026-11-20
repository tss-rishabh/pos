import { describe, expect, it } from 'vitest';
import { refundAmount } from '../../src/modules/checkout/return-workflow/gateway.js';
import { pythonFloat } from '../../src/modules/checkout/payments/legacy.js';
import { goldenStdout } from '../golden/load.js';

// API-v2's cash branch returns unrounded floats; legacy accepts them (order/views.py:947-966).
const values = [
  0.010000000000005116, 50.25, 2.675, 1.005, 0.005, 0.015, 199.99499999999998, 1234.5650000000001,
  349.00000000000006, 1e-7,
];
const oracle = asOracle(
  JSON.parse(
    goldenStdout(
      'checkout',
      'refund-amount',
      JSON.stringify({ operation: 'refund_amount', values }),
      ['refund_amount'],
    ),
  ),
);
function asOracle(value: unknown): { rounded: number[]; repr: string[] } {
  return value as { rounded: number[]; repr: string[] };
}

describe('refund amount from API-v2', () => {
  it('accepts float noise and rounds like CPython round(x, 2)', () => {
    expect(values.map(refundAmount)).toEqual(oracle.rounded.map((value) => value.toFixed(2)));
  });
  it('keeps the legacy repr for the transaction log', () => {
    expect(values.map(pythonFloat)).toEqual(oracle.repr);
  });
  it('accepts numeric strings and rejects non-numbers and real negatives', () => {
    expect(refundAmount('0.010000000000005116')).toBe('0.01');
    expect(refundAmount('50')).toBe('50.00');
    expect(refundAmount(0)).toBe('0.00');
    expect(refundAmount(-1e-15)).toBe('0.00');
    expect(refundAmount(-0.01)).toBeNull();
    expect(refundAmount('')).toBeNull();
    expect(refundAmount('abc')).toBeNull();
    expect(refundAmount(Number.NaN)).toBeNull();
    expect(refundAmount(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
