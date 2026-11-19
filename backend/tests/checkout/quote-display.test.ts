import { describe, expect, it } from 'vitest';
import {
  checkoutQuoteDisplay,
  sourceCashbackCreditMessage,
} from '../../src/domain/checkout-quote-display.js';
import { readConfig } from '../../src/config.js';

const quote = (values: Record<string, unknown>) => ({
  meta: { items: [{ name: 'calculations', ...values }] },
});
describe('read-only source quote display', () => {
  it('derives source display totals without changing official quote fields', () => {
    const input = quote({
      total_savings: '12.75',
      coupon_discount: '2.25',
      total: '25.00',
      rounding_off: '0.49',
    });
    const before = JSON.stringify(input);
    expect(checkoutQuoteDisplay(input)).toEqual({
      nonCouponDiscount: '10.50',
      totalBeforeRounding: '25.49',
      cashbackCreditMessage: sourceCashbackCreditMessage,
    });
    expect(JSON.stringify(input)).toBe(before);
  });
  it('keeps paise beyond the JavaScript safe-integer boundary', () => {
    expect(
      checkoutQuoteDisplay(quote({ total: '9007199254740993.01', rounding_off: '0.02' }))
        .totalBeforeRounding,
    ).toBe('9007199254740993.03');
  });
  it('preserves negative rounding and negative noncoupon adjustment display', () => {
    expect(
      checkoutQuoteDisplay(
        quote({ total: 25, rounding_off: -0.49, total_savings: 1, coupon_discount: 2 }),
      ),
    ).toMatchObject({ totalBeforeRounding: '24.51', nonCouponDiscount: '-1.00' });
  });
  it.each([
    {},
    { meta: null },
    quote({ total: 'NaN', rounding_off: 1 }),
    quote({ total: '9'.repeat(1000), rounding_off: 1 }),
  ])('does not invent missing or malformed amounts', (input) => {
    expect(checkoutQuoteDisplay(input)).toMatchObject({
      totalBeforeRounding: null,
      nonCouponDiscount: null,
    });
  });
  it('uses zero only when the upstream fields actually provide zero', () => {
    expect(
      checkoutQuoteDisplay(
        quote({ total: '0', rounding_off: '0', total_savings: 0, coupon_discount: 0 }),
      ),
    ).toMatchObject({ totalBeforeRounding: '0.00', nonCouponDiscount: '0.00' });
  });
  it('validates configurable source credit text and preserves explicit empty text', () => {
    const config = readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      SESSION_SECRET: 'quote-display-fixture-'.repeat(3),
      CASHBACK_CREDIT_MESSAGE: 'Configured source credit policy.',
    });
    expect(checkoutQuoteDisplay({}, config.CASHBACK_CREDIT_MESSAGE).cashbackCreditMessage).toBe(
      'Configured source credit policy.',
    );
    expect(checkoutQuoteDisplay({}, '').cashbackCreditMessage).toBe('');
    expect(() =>
      readConfig({
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'quote-display-fixture-'.repeat(3),
        CASHBACK_CREDIT_MESSAGE: 'x'.repeat(2001),
      }),
    ).toThrow();
  });
});
