import { useQuery } from '@tanstack/react-query';
import type { Checkout } from './client';
import { calculationAmounts, quoteAmount } from './quote-summary';
import { readCustomerBenefits } from '../customer-insights/benefits-client';
import type { ProfileScope } from '../customer-insights/client';
import './CartQuoteSummary.css';

/** A rupee amount from the quote, or null when the quote does not carry a numeric value. */
function rupees(value: unknown): string | null {
  const amount = quoteAmount(value);
  return amount === null ? null : `₹${amount}`;
}
/** Legacy prints the round-off as a deduction ("-" + value); the sign goes on numbers only. */
function deduction(value: unknown): string | null {
  const amount = quoteAmount(value);
  if (amount === null) return null;
  return amount.startsWith('-') ? `₹${amount.slice(1)}` : `-₹${amount}`;
}
export function CartQuoteSummary({
  checkout,
  current,
  operatorId,
}: {
  checkout: Checkout;
  current: boolean;
  operatorId: string;
}) {
  const customerId = checkout.customerId;
  const scope: ProfileScope = {
    operatorId,
    storeId: checkout.storeId,
    checkoutId: checkout.id,
    customerId: customerId || '',
  };
  const benefits = useQuery({
    queryKey: [
      operatorId,
      'checkout-customer-benefits',
      checkout.storeId,
      checkout.id,
      customerId,
      checkout.version,
    ],
    enabled: current && Boolean(customerId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => readCustomerBenefits(scope, checkout.version, signal),
  });
  const calculations = calculationAmounts(checkout.quote);
  // updateDiscountLabel (create_order.html:2509-2520): a membership product (prod_type 5) in the
  // cart relabels "Discount" as "Membership Savings".
  const hasMembershipProduct = (checkout.cart?.products.items ?? []).some(
    (item) => Number(item.prod_type) === 5,
  );
  const customer = current && !benefits.isFetching && !benefits.isError ? benefits.data : undefined;
  // W27: the breakdown exists only for a current final quote with amounts. No placeholder is
  // shown for a stale or missing quote; the dialog shows a loader while a quote is requested.
  if (!current || !calculations) return null;
  const savings: [string, string | null] = customer?.membership.active
    ? ['Membership Savings', rupees(calculations.exclusive_savings)]
    : !customerId || customer
      ? [
          hasMembershipProduct ? 'Membership Savings' : 'Discount',
          rupees(checkout.quoteDisplay?.nonCouponDiscount),
        ]
      : ['Total savings (membership unconfirmed)', rupees(calculations.total_savings)];
  // W27: a row is shown only when the final quote carries its value; nothing prints a placeholder.
  const rows = (
    [
      ['Cart Total', rupees(calculations.products_total)],
      savings,
      ['Store discount(PG)', rupees(calculations.used_store_discount_pg)],
      ['TSS Points Applied', quoteAmount(calculations.used_tss_points)],
      ['Coupon Discount', rupees(calculations.coupon_discount)],
      ['Gift Voucher', rupees(calculations.gift_voucher_value)],
      ['TSS Money Applied', rupees(calculations.used_tss_money)],
      ['GST (included in cart total)', rupees(calculations.gst_total)],
      ['Total', rupees(checkout.quoteDisplay?.totalBeforeRounding)],
      ['Round Off Value', deduction(calculations.rounding_off)],
    ] satisfies [string, string | null][]
  ).filter((row): row is [string, string] => row[1] !== null);
  // With no breakdown rows the dialog's "Confirmed payable" panel shows the payable alone.
  if (!rows.length) return null;
  const payable = rupees(calculations.total);
  const cashback =
    customer?.app.discountEligible === true ? rupees(calculations.app_cashback) : null;
  return (
    <section className="checkout-quote-summary" aria-label="Quote breakdown">
      <h3>Quote breakdown</h3>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label} className="checkout-quote-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        {payable !== null && (
          <div className="checkout-quote-row">
            <dt>Total Payable (₹)</dt>
            <dd>{payable}</dd>
          </div>
        )}
        {cashback !== null && (
          <div className="checkout-quote-row">
            <dt>Cashback Earned (₹)</dt>
            <dd>{cashback}</dd>
          </div>
        )}
      </dl>
      {cashback !== null && checkout.quoteDisplay?.cashbackCreditMessage && (
        <p>{checkout.quoteDisplay.cashbackCreditMessage}</p>
      )}
    </section>
  );
}
