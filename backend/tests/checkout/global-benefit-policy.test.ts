import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  planWalletAdjustment,
  walletAdjustmentFieldsSchema,
  walletCorrectionPatchHash,
  type WalletAdjustmentFields,
} from '../../src/modules/checkout/benefit-adjustments/policy.js';
import { benefitOracle, type BenefitOracleCase } from '../../tools/checkout/benefit-oracle.js';

const input: WalletAdjustmentFields = {
  asset: 'money',
  direction: 'subtract',
  amount: '10.00',
  platform: 'ORDER_REFUND',
  reason: 'Other',
  orderId: '9007199254740993',
  productId: '9007199254740994',
  expiry: '2026-12-31',
};
const balance = { money: 100, points: 100, cashback: 7 };

describe('explicit proposed global-wallet source corrections', () => {
  it('pins a reviewable unapplied source patch with exact before/after ledger and field bindings', () => {
    const patch = readFileSync(
      'compatibility/upstream/global-benefits/wallet-correction.patch',
      'utf8',
    );
    expect(createHash('sha256').update(patch).digest('hex')).toBe(walletCorrectionPatchHash);
    const cases: BenefitOracleCase[] = ['money', 'points'].map((asset) => ({
      asset: asset as 'money' | 'points',
      amount: '25.50',
      platform: 'ORDER_REFUND',
      reason: 'Compensation',
      orderId: '9007199254740993',
      productId: '9007199254740994',
      balances: balance,
    }));
    const original = benefitOracle(cases).cases,
      proposed = benefitOracle(cases, 'proposed-wallet-v1').cases;
    expect(original[0]!.queries.some((query) => query.includes('reward_point_history'))).toBe(true);
    expect(original[0]!.queries.at(-1)).toContain("cashback = '125.5', tss_money = '125.5'");
    expect(proposed[0]!.queries.some((query) => query.includes('reward_point_history'))).toBe(
      false,
    );
    expect(proposed[0]!.queries.at(-1)).toContain("update users set tss_money = '125.5'");
    expect(original[1]!.queries[0]).toContain(
      "'ORDER_REFUND', '25.5', '100.0', '125.5', '9007199254740993', '9007199254740994'",
    );
    expect(proposed[1]!.queries[0]).toContain(
      "'9007199254740993', '9007199254740994', '25.5', '100.0', '125.5', 'ORDER_REFUND', 'Compensation'",
    );
    expect(proposed.map((value) => value.status)).toEqual(['success', 'success']);
  });

  it('matches literal source binary-float FIFO consumption across320 coherent baskets, including cent ties', () => {
    const cases: BenefitOracleCase[] = Array.from({ length: 320 }, (_, index) => ({
      asset: index % 2 ? 'money' : 'points',
      operation: 0,
      amount: (((index % 17000) + 1) / 100).toFixed(2),
      balances: { money: 500, points: 500, cashback: 7 },
      histories: [
        {
          id: '9007199254740993',
          added_amt: index % 3 ? 0.145 : 0.29,
          used_amt: index % 7 ? 0.005 : 0,
          created_at: '2026-01-01 00:00:00',
        },
        {
          id: '9007199254740994',
          added_amt: 1.25,
          used_amt: 0.1,
          created_at: '2026-01-02 00:00:00',
        },
        { id: '9007199254740995', added_amt: 400, used_amt: 0, created_at: '2026-01-03 00:00:00' },
      ],
    }));
    const original = benefitOracle(cases),
      proposed = benefitOracle(cases, 'proposed-wallet-v1');
    for (const [index, value] of cases.entries()) {
      const plan = planWalletAdjustment(
        walletAdjustmentFieldsSchema.parse({ ...input, asset: value.asset, amount: value.amount! }),
        value.balances as typeof balance,
        value.histories!.map((row) => ({
          id: row.id,
          addedAmount: row.added_amt,
          usedAmount: row.used_amt,
          isExpired: false,
          createdAt: row.created_at!,
        })),
      );
      expect(proposed.cases[index]!.histories).toEqual(original.cases[index]!.histories);
      for (const row of original.cases[index]!.histories) {
        const change = plan.consumed.find((entry) => entry.historyId === row.id);
        expect(
          change?.usedAmount ?? value.histories!.find((entry) => entry.id === row.id)!.used_amt,
        ).toBe(row.used_amt);
      }
      expect(plan.after).toBe(500 - Number(value.amount));
      expect(plan.cashbackAfter).toBe(7);
    }
  });

  it('rejects missing earning histories, overdraft, corrupted balances and unsafe legacy FLOAT storage', () => {
    expect(() => planWalletAdjustment(input, balance, [])).toThrow('do not cover');
    expect(() => planWalletAdjustment({ ...input, amount: '100.01' }, balance, [])).toThrow(
      'exceeds',
    );
    expect(() => planWalletAdjustment(input, { ...balance, money: NaN }, [])).toThrow(
      'requires review',
    );
    expect(() =>
      planWalletAdjustment(
        { ...input, direction: 'add', amount: '0.01' },
        { ...balance, money: 1_000_000 },
        [],
      ),
    ).toThrow('cannot safely store');
  });

  it('never reinterprets unsupported source platforms, missing credit expiry, malformed input or extra fields', () => {
    for (const value of [
      { ...input, asset: 'points', platform: 'DONATION_POINTS' },
      { ...input, direction: 'add', expiry: null },
      { ...input, amount: '0' },
      { ...input, amount: '-1' },
      { ...input, amount: '1.001' },
      { ...input, amount: '100000' },
      { ...input, orderId: '1 OR 1=1' },
      { ...input, expiry: '2026-02-30' },
      { ...input, recipientEmail: 'fixture@example.test' },
    ])
      expect(walletAdjustmentFieldsSchema.safeParse(value).success).toBe(false);
  });
});
