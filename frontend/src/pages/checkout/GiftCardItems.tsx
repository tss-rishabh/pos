import { useState } from 'react';
import { z } from 'zod';
import { currency } from '../../lib/format';
import type { Checkout, CheckoutReply } from './client';

const identifier = z
  .union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive().safe()])
  .transform(String);
const itemSchema = z
  .object({
    gv_id: identifier,
    prod_id: identifier,
    quantity: z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]),
  })
  .passthrough();
type GiftItem = z.infer<typeof itemSchema>;
interface GiftCardControls {
  checkout: Checkout;
  disabled: boolean;
  act: (task: () => Promise<void>) => Promise<void>;
  mutate: (
    path: string,
    method: 'POST' | 'PUT',
    body?: Record<string, unknown>,
  ) => Promise<CheckoutReply>;
}
function GiftCardItem({
  item,
  checkout,
  disabled,
  act,
  mutate,
}: GiftCardControls & { item: GiftItem }) {
  const saved = checkout.giftCards[item.gv_id],
    dates = checkout.giftCardDates?.[item.gv_id];
  const [number, setNumber] = useState(saved?.number || ''),
    [startDate, setStartDate] = useState(saved?.startDate || dates?.startDate || ''),
    [endDate, setEndDate] = useState(saved?.endDate || dates?.endDate || ''),
    [customValue, setCustomValue] = useState(String(checkout.giftCardValues?.[item.gv_id] ?? ''));
  const value = item.gvamount ?? item.price,
    name = typeof item.product === 'string' ? item.product : 'Physical gift card',
    path = `gift-card-items/${item.gv_id}`;
  return (
    <fieldset className="gift-card-item" disabled={disabled}>
      <legend>{name}</legend>
      <p>
        Card value:{' '}
        {typeof value === 'string' || typeof value === 'number'
          ? currency(value)
          : 'Awaiting confirmation'}{' '}
        · One card
      </p>
      {item.quantity !== 1 && (
        <p role="alert">This grouped card must be removed and added as separate cards.</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await mutate(path, 'PUT', { number, startDate, endDate });
          });
        }}
      >
        <label>
          Gift card number
          <input
            value={number}
            onChange={(event) => setNumber(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9_]{6,40}"
            maxLength={40}
            required
          />
        </label>
        <div className="checkout-split">
          <label>
            Valid from
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              min="0001-01-01"
              max="9999-12-31"
              required
            />
          </label>
          <label>
            Valid until
            <input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              min={startDate || '0001-01-01'}
              max="9999-12-31"
              required
            />
          </label>
        </div>
        <button className="button secondary">Save card number and dates</button>
        {saved && <p role="status">Card number and dates are saved.</p>}
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            const requested = z.number().int().min(1).max(10000).parse(Number(customValue));
            await mutate(path + '/value', 'PUT', { customValue: requested });
          });
        }}
      >
        <label>
          Custom gift card value
          <input
            type="number"
            min={1}
            max={10000}
            step={1}
            value={customValue}
            onChange={(event) => setCustomValue(event.target.value)}
            required
          />
        </label>
        <p className="caption">
          Whole amounts from ₹1 to ₹10,000. The pricing service confirms the value before it is
          applied.
        </p>
        <button className="button secondary">Apply gift card value</button>
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            void act(async () => {
              await mutate(path + '/value', 'PUT', { customValue: null });
            })
          }
        >
          Use catalog gift card value
        </button>
      </form>
      <div className="checkout-split">
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            void act(async () => {
              await mutate('gift-card-items', 'POST', { productId: item.prod_id });
            })
          }
        >
          Add another gift card
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            void act(async () => {
              await mutate(path + '/removals', 'POST');
            })
          }
        >
          Remove this gift card
        </button>
      </div>
    </fieldset>
  );
}
export function GiftCardItems(props: GiftCardControls) {
  const raw = props.checkout.cart?.giftvouchers;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('items' in raw) ||
    !Array.isArray(raw.items) ||
    !raw.items.length
  )
    return null;
  const parsed = z.array(itemSchema).max(100).safeParse(raw.items);
  if (!parsed.success)
    return (
      <p role="alert">
        Gift card details could not be confirmed. Refresh the checkout before continuing.
      </p>
    );
  return (
    <details open>
      <summary>Physical gift cards</summary>
      <p>Save a different card number for every physical card before requesting the final quote.</p>
      {parsed.data.map((item) => (
        <GiftCardItem
          key={item.gv_id + JSON.stringify(props.checkout.giftCards[item.gv_id] ?? null)}
          {...props}
          item={item}
        />
      ))}
    </details>
  );
}
