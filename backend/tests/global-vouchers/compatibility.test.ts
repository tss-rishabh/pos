import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  giftCardDatesValid,
  planVoucherConversion,
  voucherAmountString,
  voucherMinorUnits,
} from '../../src/modules/global-vouchers/policy.js';
import { readGlobalVoucherOptions } from '../../src/modules/global-vouchers/options.js';

describe('reviewed voucher consumer compatibility', () => {
  it('uses source six/86400 PIN defaults and refuses configuration that would loosen them', () => {
    expect(readGlobalVoucherOptions({})).toMatchObject({
      GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT: 6,
      GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT_EX: 86400,
    });
    expect(() => readGlobalVoucherOptions({ GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT: '7' })).toThrow();
    expect(() =>
      readGlobalVoucherOptions({ GLOBAL_VOUCHER_GIFT_CARD_PIN_LIMIT_EX: '1800' }),
    ).toThrow();
  });
  it('dry-applies every pinned patch and executes original/current cart/check consumers with NULL nonexpiry', () => {
    const raw = execFileSync('python3', ['tools/global-vouchers/compatibility-oracle.py'], {
      encoding: 'utf8',
    });
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
  it('keeps cents exact, rejects corrupt/fractional-paisa balances and cannot store unsafe wallet FLOAT', () => {
    for (const amount of ['0.01', '25.49', '25.50', '99999999'])
      expect(voucherMinorUnits(voucherAmountString(voucherMinorUnits(amount)))).toBe(
        voucherMinorUnits(amount),
      );
    expect(planVoucherConversion(25.49, 25.49, 100, 7)).toMatchObject({
      amount: 2549n,
      before: 10000n,
      after: 12549n,
    });
    expect(() => planVoucherConversion(25.555, 25.555, 100, 7)).toThrow();
    expect(() => planVoucherConversion(26, 25.5, 100, 7)).toThrow();
    expect(() => planVoucherConversion(99999999, 99999999, 100, 7)).toThrow();
  });
  it('preserves inclusive source gift-card date/zero sentinel boundaries while rejecting NULL gift cards', () => {
    const now = '2026-06-15 12:00:00';
    expect(giftCardDatesValid(now, now, now)).toBe(true);
    expect(giftCardDatesValid('0000-00-00 00:00:00', '0000-00-00 00:00:00', now)).toBe(true);
    expect(giftCardDatesValid(null, null, now)).toBe(false);
    expect(giftCardDatesValid('2026-06-15 12:00:01', '2026-07-01 00:00:00', now)).toBe(false);
    expect(giftCardDatesValid('2026-01-01 00:00:00', '2026-06-15 11:59:59', now)).toBe(false);
  });
});
