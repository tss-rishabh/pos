import { useQuery } from '@tanstack/react-query';
import type { Checkout } from './client';
import { calculationAmounts, quoteAmount } from './quote-summary';
import { readCustomerBenefits } from '../customer-insights/benefits-client';
import type { ProfileScope } from '../customer-insights/client';
import './CartQuoteSummary.css';

function Amount({ value }: { value: unknown }) {
  const amount = quoteAmount(value);
  return <>{amount === null ? 'Unavailable — refresh quote' : `₹${amount}`}</>;
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
  const customer = current && !benefits.isFetching && !benefits.isError ? benefits.data : undefined;
  return (
    <section className="checkout-quote-summary" aria-label="Quote breakdown">
      <h3>Quote breakdown</h3>
      {!current && (
        <p role="status">
          This breakdown is not a current final quote. Refresh the sale and get a final quote before
          confirming.
        </p>
      )}
      {!calculations ? (
        <p role="status">
          Quote amounts are unavailable. Get a final quote to review the breakdown.
        </p>
      ) : (
        <>
          <dl>
            <dt>Cart total</dt>
            <dd>
              <Amount value={calculations.products_total} />
            </dd>
            {customer?.membership.active ? (
              <>
                <dt>Membership savings</dt>
                <dd>
                  <Amount value={calculations.exclusive_savings} />
                </dd>
              </>
            ) : !customerId || customer ? (
              <>
                <dt>Discount (excluding coupon)</dt>
                <dd>
                  <Amount value={checkout.quoteDisplay?.nonCouponDiscount} />
                </dd>
              </>
            ) : (
              <>
                <dt>Total savings (membership unconfirmed)</dt>
                <dd>
                  <Amount value={calculations.total_savings} />
                </dd>
              </>
            )}

            <dt>Store discount (PG)</dt>
            <dd>
              <Amount value={calculations.used_store_discount_pg} />
            </dd>
            <dt>TSS Points applied</dt>
            <dd>
              <Amount value={calculations.used_tss_points} />
            </dd>
            <dt>Coupon discount</dt>
            <dd>
              <Amount value={calculations.coupon_discount} />
            </dd>
            <dt>Gift voucher</dt>
            <dd>
              <Amount value={calculations.gift_voucher_value} />
            </dd>
            <dt>TSS Money applied</dt>
            <dd>
              <Amount value={calculations.used_tss_money} />
            </dd>
            <dt>GST (included in cart total)</dt>
            <dd>
              <Amount value={calculations.gst_total} />
            </dd>
            <dt>Total before rounding</dt>
            <dd>
              <Amount value={checkout.quoteDisplay?.totalBeforeRounding} />
            </dd>
            <dt>Rounding value</dt>
            <dd>
              <Amount value={calculations.rounding_off} />
            </dd>
            <dt>Official payable</dt>
            <dd>
              <Amount value={calculations.total} />
            </dd>
            {customer?.app.discountEligible === true && (
              <>
                <dt>Cashback earned</dt>
                <dd>
                  <Amount value={calculations.app_cashback} />
                </dd>
              </>
            )}
          </dl>
          {customer?.app.discountEligible === true && (
            <p>
              {checkout.quoteDisplay?.cashbackCreditMessage ??
                'Cashback credit timing is unavailable. Refresh the sale.'}
            </p>
          )}
          {current && customerId && (!customer || customer.app.discountEligible === null) && (
            <p role="status">
              Cashback eligibility is unavailable. No cashback amount is promised.
            </p>
          )}
        </>
      )}
    </section>
  );
}
