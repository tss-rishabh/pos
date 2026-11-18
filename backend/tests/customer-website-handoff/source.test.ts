import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { goldenStdout } from '../golden/load.js';
describe('executed pinned website-handoff source oracle', () => {
  it('preserves original customer/store/operator identity facts while exposing the source URL credential flaw', () => {
    const result = z
      .object({
        pin: z.string(),
        sourceHashes: z.record(z.string(), z.string()),
        vectors: z.array(
          z.object({
            twoFactor: z.boolean(),
            algorithm: z.string(),
            prefix: z.boolean(),
            customerId: z.string(),
            expirySeconds: z.number(),
            path: z.string(),
            queryKeys: z.array(z.string()),
            storeId: z.string(),
            operatorCustomerId: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(goldenStdout('customer-website-handoff', 'source')) as unknown);
    expect(result.pin).toBe('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a');
    expect(result.vectors.map((v) => [v.algorithm, v.prefix, v.operatorCustomerId])).toEqual([
      ['HS256', false, '88'],
      ['HS512', true, '88'],
      ['HS256', false, '0'],
    ]);
    for (const vector of result.vectors) {
      expect(vector).toMatchObject({
        customerId: '7',
        storeId: '1',
        expirySeconds: 300,
        path: '/pos/login/',
      });
      expect(vector.queryKeys).toEqual(['api_key', 'pos_store_id', 'pos_user_id', 'token']);
    }
    expect(Object.keys(result.sourceHashes)).toHaveLength(2);
  }, 20000);
});
