import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pendingCancellationOptions } from '../../src/modules/checkout/cancellations/options.js';
import { planCancellationBenefitCandidate } from '../../src/modules/checkout/cancellations/benefit-candidate.js';
describe('source cancellation differential and approved original-expiry policy', () => {
  it('differentially executes original Money/Points helpers and preserves coherent values while exposing source anomalies', () => {
    const result = z
      .object({
        sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
        cases: z.array(
          z.object({
            kind: z.string(),
            name: z.string(),
            original: z.object({
              user: z.object({
                tss_money: z.number(),
                tss_points: z.number(),
                cashback: z.number(),
              }),
              sourceCommits: z.number(),
              ledger: z.array(
                z.object({
                  ledger: z.string(),
                  added_amt: z.number(),
                  expiry: z.string().optional(),
                }),
              ),
            }),
            candidate: z.object({
              user: z
                .object({ tss_money: z.number(), tss_points: z.number(), cashback: z.number() })
                .optional(),
              sourceCommits: z.number().optional(),
              ledger: z
                .array(
                  z.object({
                    ledger: z.string(),
                    added_amt: z.number(),
                    expiry: z.string().optional(),
                  }),
                )
                .optional(),
              rejected: z.string().optional(),
            }),
          }),
        ),
      })
      .parse(
        JSON.parse(
          execFileSync('python3', ['tools/checkout/cancellation_wallet_oracle.py'], {
            encoding: 'utf8',
          }),
        ) as unknown,
      );
    expect(result.cases).toHaveLength(12);
    const money = result.cases.find((row) => row.kind === 'money' && row.name === 'one-earning')!;
    expect(money.original.user).toEqual({ tss_money: 105, tss_points: 200, cashback: 105 });
    expect(money.candidate.user).toEqual({ tss_money: 105, tss_points: 200, cashback: 7 });
    expect(money.original.ledger.map((row) => row.ledger)).toEqual(['reward', 'money']);
    expect(money.candidate.ledger?.map((row) => row.ledger)).toEqual(['money']);
    expect(money.original.sourceCommits).toBe(1);
    expect(money.candidate.sourceCommits).toBe(0);
    const points = result.cases.find(
      (row) => row.kind === 'points' && row.name === 'two-expiries',
    )!;
    expect(points.original.ledger[0]?.expiry).toContain('2027-05-01');
    expect(points.candidate.rejected).toBe('CANCELLATION_POINTS_EXPIRY_POLICY_REQUIRED');
    for (const row of result.cases.filter((row) =>
      ['no-mapping', 'incomplete-mapping', 'expired-earning'].includes(row.name),
    ))
      expect(row.candidate.rejected).toBeTruthy();
  });
  it('enforces the approved original-expiry policy without crediting expired money or mixing bonus buckets', () => {
    const planned = planCancellationBenefitCandidate(
      8,
      [
        {
          mappingId: '9007199254740995',
          historyId: '103',
          used: 5,
          returned: 0,
          expiry: '2027-05-01 00:00:00',
          expired: false,
          bonus: true,
        },
        {
          mappingId: '9007199254740993',
          historyId: '101',
          used: 3,
          returned: 1,
          expiry: '2026-11-16 00:00:00',
          expired: false,
          bonus: false,
        },
        {
          mappingId: '9007199254740994',
          historyId: '102',
          used: 4,
          returned: 0,
          expiry: '2027-02-01 00:00:00',
          expired: false,
          bonus: false,
        },
      ],
      '2026-11-17',
    );
    expect(planned.expiredAmount).toBe(2);
    expect(planned.credits).toEqual([
      { expiry: '2027-02-01 00:00:00', bonus: false, amount: 4 },
      { expiry: '2027-05-01 00:00:00', bonus: true, amount: 2 },
    ]);
    expect(planned.allocations.map((row) => row.returnedAfter)).toEqual([3, 4, 2]);
    expect(() =>
      planCancellationBenefitCandidate(
        20,
        [
          {
            mappingId: '1',
            historyId: '1',
            used: 3,
            returned: 0,
            expiry: null,
            expired: false,
            bonus: false,
          },
        ],
        '2026-11-17',
      ),
    ).toThrow('reconciliation');
  });
  it('keeps benefit mutations unselected until every explicit shared writer prerequisite is supplied', () => {
    const policy = {
      POS_PENDING_CANCELLATION_BENEFIT_POLICY: 'pos-cancellation-original-expiry-v1',
    };
    expect(pendingCancellationOptions({}).benefitProfile).toBeUndefined();
    expect(pendingCancellationOptions(policy).benefitProfile).toBeUndefined();
    expect(
      pendingCancellationOptions({
        ...policy,
        GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT: 'pos-wallet-user-lock-v1',
      }).benefitProfile,
    ).toBeUndefined();
    expect(
      pendingCancellationOptions({
        ...policy,
        GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT: 'pos-wallet-user-lock-v1',
        POS_PENDING_CANCELLATION_VOUCHER_LOCK_CONTRACT: 'pos-voucher-user-lock-v1',
      }).benefitProfile,
    ).toMatchObject({
      policy: policy.POS_PENDING_CANCELLATION_BENEFIT_POLICY,
      walletWriterContract: 'pos-wallet-user-lock-v1',
      voucherWriterContract: 'pos-voucher-user-lock-v1',
    });
    expect(() =>
      pendingCancellationOptions({
        ...policy,
        POS_PENDING_CANCELLATION_VOUCHER_LOCK_CONTRACT: 'unverified',
      }),
    ).toThrow();
    expect(() =>
      pendingCancellationOptions({
        ...policy,
        POS_PENDING_CANCELLATION_MEMBERSHIP_PROOF_KEY: 'short',
      }),
    ).toThrow();
  });
});
