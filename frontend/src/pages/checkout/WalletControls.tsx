import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Checkout, CheckoutReply } from './client';
import { quoteAmount } from './quote-summary';
import { readCustomerBenefits } from '../customer-insights/benefits-client';

/**
 * Legacy TSS Points / TSS Money switches (`create_order.html:376-447`, JS `:3057-3330`,
 * `AjaxWalletView` `order/views.py:2138-2189`): each switch is initialised from the applied cart
 * state, applies immediately when toggled, is enabled only for a verified customer with a balance
 * above zero, and shows `used/total` once applied. "Desired Tss Money" applies a partial amount.
 */
function metaItem(checkout: Checkout, name: string): Record<string, unknown> | null {
  const meta = checkout.cart?.meta;
  if (typeof meta !== 'object' || meta === null || !('items' in meta) || !Array.isArray(meta.items))
    return null;
  const found: unknown = meta.items.find(
    (item: unknown) =>
      typeof item === 'object' && item !== null && 'name' in item && item.name === name,
  );
  return typeof found === 'object' && found !== null ? (found as Record<string, unknown>) : null;
}
const positive = (value: unknown) => {
  const amount = quoteAmount(value);
  return amount !== null && Number(amount) > 0 ? amount : null;
};

export function WalletControls({
  checkout,
  operatorId,
  disabled,
  act,
  mutate,
}: {
  checkout: Checkout;
  operatorId: string;
  disabled: boolean;
  act: (task: () => Promise<void>) => Promise<void>;
  mutate: (
    path: string,
    method: 'POST' | 'PUT',
    body?: Record<string, unknown>,
  ) => Promise<CheckoutReply>;
}) {
  const customerId = checkout.customerId;
  const balances = useQuery({
    queryKey: [
      operatorId,
      'checkout-customer-benefits',
      checkout.storeId,
      checkout.id,
      customerId,
      checkout.version,
    ],
    enabled: Boolean(customerId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: ({ signal }) =>
      readCustomerBenefits(
        { operatorId, storeId: checkout.storeId, checkoutId: checkout.id, customerId: customerId! },
        checkout.version,
        signal,
      ),
  });
  const money = metaItem(checkout, 'tss_money'),
    points = metaItem(checkout, 'tss_points');
  const usedMoney = positive(money?.used_tss_money),
    usedPoints = positive(points?.used_tss_points),
    partial = Boolean(money?.custom_tss_money);
  const [desired, setDesired] = useState(usedMoney ?? '');
  const verified = Boolean(
    checkout.verifiedCustomerUntil && checkout.verifiedCustomerUntil > Date.now(),
  );
  const moneyBalance = balances.data?.wallet.money ?? null,
    pointsBalance = balances.data?.wallet.points ?? null;
  const canMoney = Boolean(customerId && verified && moneyBalance && Number(moneyBalance) > 0),
    canPoints = Boolean(customerId && verified && pointsBalance && Number(pointsBalance) > 0);
  const apply = (next: {
    money: boolean;
    points: boolean;
    appliedMoney: string;
    custom: boolean;
  }) =>
    void act(async () => {
      await mutate('wallet', 'PUT', next);
    });
  const badge = (used: string | null, total: unknown, balance: string | null) =>
    used ? `${used}/${quoteAmount(total) ?? balance ?? '0'}` : (balance ?? '0');
  return (
    <div className="wallet-controls">
      <label>
        <input
          type="checkbox"
          checked={Boolean(usedPoints)}
          disabled={disabled || !canPoints}
          onChange={(event) =>
            apply({
              money: Boolean(usedMoney),
              points: event.target.checked,
              appliedMoney: partial && usedMoney ? usedMoney : '0.00',
              custom: partial,
            })
          }
        />{' '}
        Tss Points{' '}
        <span className="badge">{badge(usedPoints, points?.total_tss_points, pointsBalance)}</span>
      </label>
      <label>
        <input
          type="checkbox"
          checked={Boolean(usedMoney)}
          disabled={disabled || !canMoney}
          onChange={(event) =>
            apply({
              money: event.target.checked,
              points: Boolean(usedPoints),
              appliedMoney: '0.00',
              custom: false,
            })
          }
        />{' '}
        Tss Money{' '}
        <span className="badge">{badge(usedMoney, money?.total_tss_money, moneyBalance)}</span>
      </label>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply({ money: true, points: Boolean(usedPoints), appliedMoney: desired, custom: true });
        }}
      >
        <label>
          Desired Tss Money {partial ? '(Partial Money Applied)' : ''}
          <input
            type="number"
            min={0}
            max={9999999}
            step="0.01"
            value={desired}
            onChange={(event) => setDesired(event.target.value)}
            disabled={disabled || !canMoney}
          />
        </label>
        <button className="button secondary" disabled={disabled || !canMoney || !desired}>
          Apply
        </button>
      </form>
      {customerId && !verified && (
        <p className="caption">Verify the user to use Tss Money/Points/Voucher !</p>
      )}
    </div>
  );
}
