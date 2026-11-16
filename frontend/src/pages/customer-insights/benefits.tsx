import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck } from 'lucide-react';
import { ErrorState, Loading } from '../../components/common';
import type { ProfileScope } from './client';
import { readCustomerBenefits } from './benefits-client';
import './style.css';

export function CustomerBenefitsCard({
  scope,
  checkoutVersion,
  online,
  disabled = false,
}: {
  scope: ProfileScope;
  checkoutVersion: number;
  online: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const benefits = useQuery({
    queryKey: [
      scope.operatorId,
      'checkout-customer-benefits',
      scope.storeId,
      scope.checkoutId,
      scope.customerId,
      checkoutVersion,
    ],
    enabled: open && online && !disabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) => readCustomerBenefits(scope, checkoutVersion, signal),
  });
  const value = benefits.data;
  return (
    <section aria-label="Customer benefits">
      <button
        className="button secondary"
        type="button"
        disabled={!online || disabled}
        aria-expanded={open && online && !disabled}
        onClick={() => setOpen(!open)}
      >
        <BadgeCheck size={15} />
        {open ? 'Hide customer benefits' : 'Customer benefits'}
      </button>
      {open && online && !disabled && (
        <div className="customer-profile-panel">
          {benefits.isPending || benefits.isFetching ? (
            <Loading />
          ) : benefits.isError ? (
            <ErrorState error={benefits.error} retry={() => void benefits.refetch()} />
          ) : (
            value && (
              <>
                <dl>
                  <dt>Membership</dt>
                  <dd>
                    {value.membership.active ? 'Exclusive member' : 'Non-exclusive member'}
                    {value.membership.expiry
                      ? ` · until ${value.membership.expiry.slice(0, 10)}`
                      : ''}
                  </dd>
                  <dt>TSS Money</dt>
                  <dd>₹{value.wallet.money}</dd>
                  <dt>TSS Points</dt>
                  <dd>{value.wallet.points}</dd>
                  <dt>Active gift vouchers</dt>
                  <dd>{value.activeGiftVoucherCount}</dd>
                  <dt>App user</dt>
                  <dd>{value.app.isAppUser ? 'Yes' : 'No'}</dd>
                  <dt>App cashback</dt>
                  <dd>
                    {value.app.discountEligible === null
                      ? 'Temporarily unavailable'
                      : value.app.discountEligible
                        ? 'Eligible'
                        : 'Not eligible'}
                  </dd>
                  <dt>Customer since</dt>
                  <dd>{value.customerSince?.slice(0, 10) || '—'}</dd>
                </dl>
                {value.membership.message && <p role="status">{value.membership.message}</p>}
                <p className="caption">
                  Final offers and balances are validated when applied to the sale.
                </p>
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
