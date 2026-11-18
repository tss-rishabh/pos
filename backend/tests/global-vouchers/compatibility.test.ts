import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  voucherAmountString,
  voucherMinorUnits,
} from '../../src/modules/global-vouchers/policy.js';
import { goldenStdout } from '../golden/load.js';

describe('reviewed voucher consumer compatibility', () => {
  it('dry-applies every pinned patch and executes original/current cart/check consumers with NULL nonexpiry', () => {
    const raw = goldenStdout('global-vouchers', 'compatibility');
    const result = z
      .object({
        patchesDryApplied: z.number(),
        ordinaryDatesSkipped: z.boolean(),
        cart: z.array(
          z.union([
            z.object({ value: z.number(), hasDates: z.boolean() }),
            z.object({ error: z.string() }),
          ]),
        ),
        originalCheck: z.object({ voucher_validity: z.null(), voucher_value: z.number() }),
        candidateCheck: z.object({ voucher_validity: z.string(), voucher_value: z.number() }),
        enumHasGvAdd: z.boolean(),
        genericCouponExcludesType3: z.boolean(),
        exactCandidateUsesInitial: z.boolean(),
        pinPolicy: z.object({
          limit: z.number(),
          ttlSeconds: z.number(),
          blockedValidBeforeExpiry: z.boolean(),
          blockedAttemptExpiresAt: z.number(),
          acceptedValidAtExpiry: z.boolean(),
          sliding: z.array(
            z.object({ at: z.number(), failures: z.number(), expiresAt: z.number() }),
          ),
        }),
      })
      .parse(JSON.parse(raw) as unknown);
    expect(result).toMatchObject({
      patchesDryApplied: 3,
      ordinaryDatesSkipped: true,
      enumHasGvAdd: true,
      genericCouponExcludesType3: true,
      exactCandidateUsesInitial: true,
      candidateCheck: { voucher_validity: '0000-00-00 00:00:00', voucher_value: 25.49 },
    });
    expect(result.cart).toEqual([
      { value: 25.5, hasDates: false },
      { value: 25, hasDates: false },
      { error: 'No balance in applied voucher.' },
      { value: 25.49, hasDates: false },
      { value: 0.01, hasDates: false },
    ]);
    expect(result.candidateCheck.voucher_validity.split(' ')[0]).toBe('0000-00-00');
    expect(result.pinPolicy).toEqual({
      limit: 6,
      ttlSeconds: 86400,
      blockedValidBeforeExpiry: true,
      blockedAttemptExpiresAt: 86400,
      acceptedValidAtExpiry: true,
      sliding: [
        { at: 0, failures: 1, expiresAt: 86400 },
        { at: 1800, failures: 2, expiresAt: 88200 },
        { at: 86400, failures: 3, expiresAt: 172800 },
        { at: 172800, failures: 1, expiresAt: 259200 },
      ],
    });
  });
  it('keeps issuance cents exact', () => {
    for (const amount of ['0.01', '25.49', '25.50', '99999999'])
      expect(voucherMinorUnits(voucherAmountString(voucherMinorUnits(amount)))).toBe(
        voucherMinorUnits(amount),
      );
    expect(() => voucherMinorUnits('25.555')).toThrow();
    expect(() => voucherMinorUnits('0')).toThrow();
  });
});
