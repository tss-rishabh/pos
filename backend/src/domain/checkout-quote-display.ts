import { Decimal } from 'decimal.js';
import { z } from 'zod';

export const sourceCashbackCreditMessage =
  'Cashback will be credited after 15 days post delivery/billing, if there is no return.';

const amount = z.union([
  z.number().finite(),
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^-?\d+(?:\.\d+)?(?:e[+-]?\d{1,3})?$/i),
]);
// Enough precision for both bounded source decimals, including their exponent
// difference. This projection changes display only, never quote/payment values.
const Exact = Decimal.clone({ precision: 2200, rounding: Decimal.ROUND_HALF_UP });
const metadata = z.object({
  meta: z.object({ items: z.array(z.record(z.string(), z.unknown())).max(1000) }),
});

export interface CheckoutQuoteDisplay {
  nonCouponDiscount: string | null;
  totalBeforeRounding: string | null;
  cashbackCreditMessage: string;
}

export function checkoutQuoteDisplay(
  quote: unknown,
  cashbackCreditMessage = sourceCashbackCreditMessage,
): CheckoutQuoteDisplay {
  const parsed = metadata.safeParse(quote);
  const calculations = parsed.success
    ? parsed.data.meta.items.find((row) => row.name === 'calculations')
    : undefined;
  function derive(left: string, right: string, subtract = false): string | null {
    const first = amount.safeParse(calculations?.[left]);
    const second = amount.safeParse(calculations?.[right]);
    if (!first.success || !second.success) return null;
    const a = new Exact(first.data),
      b = new Exact(second.data);
    const result = (subtract ? a.minus(b) : a.plus(b)).toFixed(2);
    return result.length <= 256 ? result : null;
  }
  return {
    nonCouponDiscount: derive('total_savings', 'coupon_discount', true),
    totalBeforeRounding: derive('total', 'rounding_off'),
    cashbackCreditMessage,
  };
}
