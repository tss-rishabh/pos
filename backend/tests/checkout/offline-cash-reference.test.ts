import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { offlineCashOrderReference } from '../../src/modules/checkout/offline-cash/order-reference.js';
import { goldenStdout } from '../golden/load.js';

describe('offline cash source MOBILE order references', () => {
  it('matches the isolated original generator across tail corrections and exact BIGINT order IDs', () => {
    const vectors = [
      '100',
      '101',
      '102',
      '108',
      '999',
      '1234567',
      '9007199254740993',
      '9223372036854775807',
    ].flatMap((orderId) =>
      [11, 42, 99].flatMap((prefix) => [2, 9].map((last) => ({ orderId, prefix, last }))),
    );
    const original = z
      .array(z.string())
      .parse(
        JSON.parse(
          goldenStdout('checkout', 'offline-cash-reference', JSON.stringify(vectors)),
        ) as unknown,
      );
    expect(
      vectors.map((vector) => {
        const draws = [vector.prefix, vector.last];
        return offlineCashOrderReference(vector.orderId, () => draws.shift()!);
      }),
    ).toEqual(original);
  });
  it('rejects unsupported or unsafe identity inputs before assigning a reference', () => {
    for (const value of ['1', '0', '-100', '1e12', '9007199254740993x', '92233720368547758070'])
      expect(() => offlineCashOrderReference(value)).toThrow();
  });
});
