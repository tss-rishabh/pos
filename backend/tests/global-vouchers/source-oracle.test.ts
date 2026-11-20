import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { goldenStdout } from '../golden/load.js';
/**
 * Source evidence only (V2, 20 Nov 2026; see tests/golden/INVENTORY.md): this file asserts
 * facts of the pinned legacy capture and runs no rewrite code.
 * Reason: the historical conversion route is absent at the pinned source (currentRoutePresent
 * false), so the rewrite has no counterpart route whose output could be compared.
 */

const resultSchema = z.object({
  parentCommit: z.string(),
  removalCommit: z.string(),
  currentRoutePresent: z.boolean(),
  cases: z.array(
    z.object({
      kind: z.string(),
      requiresPin: z.boolean(),
      pinEnabled: z.boolean(),
      amount: z.number(),
      outcomes: z.array(z.string()),
      voucherBalance: z.number(),
      voucherStatus: z.number(),
      money: z.number(),
      commits: z.number(),
      histories: z.array(
        z.object({
          kind: z.string(),
          added: z.number(),
          before: z.number(),
          after: z.number(),
          platform: z.string(),
        }),
      ),
    }),
  ),
});
describe('literal historical conversion source', () => {
  it('pins the removed route and proves ordinary/card consumption, duplicate credits and ledger rounding', () => {
    const raw = goldenStdout('global-vouchers', 'source-oracle');
    const result = resultSchema.parse(JSON.parse(raw) as unknown);
    expect(result.parentCommit).toBe('02bfa5902f06faa5e648c4d5ad64c2e72646853e');
    expect(result.currentRoutePresent).toBe(false);
    expect(result.cases[0]).toMatchObject({
      voucherBalance: 0,
      voucherStatus: 1,
      money: 125.5,
      commits: 3,
    });
    expect(result.cases[0]?.outcomes[1]).toBe('Insufficient Voucher Balance, please try again');
    expect(result.cases[1]).toMatchObject({
      voucherBalance: 25.5,
      voucherStatus: 1,
      money: 151,
      commits: 4,
    });
    expect(result.cases[2]).toMatchObject({
      voucherBalance: 0,
      voucherStatus: 0,
      money: 125.5,
      commits: 3,
    });
    expect(result.cases[3]).toMatchObject({ voucherBalance: 25.5, voucherStatus: 1, money: 151 });
    expect(result.cases[4]?.histories).toEqual([
      { kind: 'gift', added: -25.56, before: 25.56, after: 0, platform: 'MISC_COMPENSATION' },
      { kind: 'reward', added: 25.555, before: 100, after: 125.555, platform: 'CASHBACK_EARNED' },
      { kind: 'money', added: 25.555, before: 100, after: 125.555, platform: 'MISC_COMPENSATION' },
    ]);
  });
});
