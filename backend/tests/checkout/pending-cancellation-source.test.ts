import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pendingCancellationOptions } from '../../src/modules/checkout/cancellations/options.js';
import { goldenStdout } from '../golden/load.js';
describe('pinned pending cash-on-counter cancellation boundaries', () => {
  it('executes the original web and API-v2 handlers with exact long line IDs, duplicate SKUs and no cash refund', () => {
    const parsed = z
      .object({
        sourceCommits: z.object({
          web: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
          apiV2: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
        }),
        cases: z.array(
          z.object({
            name: z.string(),
            result: z.object({ status: z.number() }),
            statuses: z.object({ order: z.number(), payment: z.number() }),
            stocks: z.record(z.string(), z.number()),
            stockCalls: z.array(z.object({ after: z.number() })),
            apiEffects: z.array(z.object({ kind: z.string(), lineId: z.string() })),
            logs: z.array(
              z.object({ payDict: z.record(z.string(), z.unknown()), comment: z.string() }),
            ),
          }),
        ),
      })
      .parse(
        JSON.parse(
          goldenStdout('checkout', 'pending-cancellation-source.pending-cancellation-oracle'),
        ) as unknown,
      );
    expect(parsed.cases).toHaveLength(6);
    for (const source of parsed.cases.filter((row) => !row.name.startsWith('partial'))) {
      expect(source.result.status).toBe(200);
      expect(source.statuses).toEqual({ order: 4, payment: 2 });
      expect(source.logs).toEqual([
        { payDict: {}, comment: 'Order Cancelled : No Transaction Made' },
      ]);
    }
    expect(parsed.cases.find((row) => row.name === 'duplicate-sku')?.stocks['10']).toBe(15);
    expect(parsed.cases.find((row) => row.name === 'long-identifiers')?.apiEffects[0]?.lineId).toBe(
      '9007199254741000',
    );
    expect(parsed.cases.find((row) => row.name === 'partial-source-error')).toMatchObject({
      result: { status: 400 },
      stocks: { '10': 10, '11': 10 },
    });
    expect(
      parsed.cases.find((row) => row.name === 'partial-source-error')?.apiEffects,
    ).toHaveLength(2);
    expect(
      parsed.cases.find((row) => row.name === 'missing-stock-source-success')?.stockCalls,
    ).toEqual([]);
  });
  it('retains the literal source screening non-cancellation predicate without claiming its old writer enforced it', () => {
    const result = z
      .object({
        sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
        cases: z.array(
          z.object({
            productId: z.union([z.number(), z.string(), z.null()]),
            blocked: z.boolean(),
            message: z.string(),
          }),
        ),
      })
      .parse(
        JSON.parse(
          goldenStdout('checkout', 'pending-cancellation-source.screening-cancellation-oracle'),
        ) as unknown,
      );
    expect(result.cases.map((row) => row.blocked)).toEqual([true, true, false, false]);
    expect(result.cases[0]?.message).toBe("Screening tickets can't be cancelled.");
  });
  it('requires explicit source contract and membership configuration without assuming an empty list', () => {
    expect(pendingCancellationOptions({})).toEqual({
      contract: undefined,
      membershipProductIds: undefined,
    });
    expect(
      pendingCancellationOptions({
        POS_PENDING_CANCELLATION_CONTRACT: 'pos-pending-order-cancellation-v1',
        POS_PENDING_CANCELLATION_MEMBERSHIP_PRODUCT_IDS: '["9007199254740993"]',
      }).membershipProductIds,
    ).toEqual(['9007199254740993']);
    expect(() =>
      pendingCancellationOptions({ POS_PENDING_CANCELLATION_MEMBERSHIP_PRODUCT_IDS: '[1]' }),
    ).toThrow();
  });
});
