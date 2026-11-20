import { it, expect } from 'vitest';
import { z } from 'zod';
import { goldenStdout } from '../golden/load.js';
/**
 * Source evidence only (V2, 20 Nov 2026; see tests/golden/INVENTORY.md): this file asserts
 * facts of the pinned legacy capture and runs no rewrite code.
 * Reason: the rewrite's messages are compared with these vectors in
 * tests/checkout-order-copy/service.mysql.test.ts; the legacy defects pinned here are deliberately
 * not reproduced.
 */
it('executes six literal source handler vectors without Django/Redis/providers', () => {
  const vectors = z
    .record(
      z.string(),
      z.object({
        calls: z.number(),
        productIds: z.array(z.number()),
        message: z.string(),
        status: z.number(),
        syncs: z.number(),
        clears: z.number(),
        syncedItems: z.array(z.object({ prod_id: z.number(), quantity: z.number() })),
      }),
    )
    .parse(JSON.parse(goldenStdout('checkout-order-copy', 'source')) as unknown);
  expect(Object.keys(vectors)).toHaveLength(6);
  expect(vectors.normal!.calls).toBe(2);
  expect(vectors['duplicate-sku']!.productIds).toEqual([10, 10]);
  // Preserve the source defect as evidence, not as a claimed success parity:
  // source concatenates whole cart responses and can label thrown partial work synced.
  expect(vectors.normal!.syncedItems).toHaveLength(3);
  expect(vectors['thrown-error']!.message).toBe('Cart Synced');
});
