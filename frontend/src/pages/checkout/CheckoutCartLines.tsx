import { useState } from 'react';
import { z } from 'zod';
import type { Checkout, CheckoutReply } from './client';
import { quoteAmount } from './quote-summary';
const identifier = z
  .union([z.string().regex(/^[1-9]\d{0,19}$/), z.number().int().positive().safe()])
  .transform(String);
const line = z
  .object({
    prod_id: identifier,
    product: z.string().max(1000),
    quantity: z.union([
      z.number().int().nonnegative().safe(),
      z
        .string()
        .regex(/^\d{1,9}$/)
        .transform(Number),
    ]),
    price: z.unknown(),
    spl_price: z.unknown().optional(),
    parent_prod_id: z
      .union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative().safe()])
      .transform(String)
      .optional(),
  })
  .passthrough();
export function checkoutCartLines(cart: Checkout['cart']) {
  const products = z.array(line).max(500).safeParse(cart?.products.items);
  const complementary = z
    .array(line)
    .max(500)
    .safeParse(cart?.complementary_products?.items ?? []);
  return products.success && complementary.success
    ? { products: products.data, complementary: complementary.data }
    : null;
}
export function CheckoutCartLines({
  checkout,
  disabled,
  act,
  mutate,
}: {
  checkout: Checkout;
  disabled: boolean;
  act: (task: () => Promise<void>) => Promise<void>;
  mutate: (
    path: string,
    method: 'PUT' | 'POST',
    body?: Record<string, unknown>,
  ) => Promise<CheckoutReply>;
}) {
  if (!checkout.cart) return null;
  const lines = checkoutCartLines(checkout.cart);
  if (!lines)
    return (
      <p role="status">
        Cart line details are unavailable. Refresh the sale before reviewing its items.
      </p>
    );
  const rows = [
    ...lines.products.map((item) => ({ item, complementary: false })),
    ...lines.complementary.map((item) => ({ item, complementary: true })),
  ];
  const price = (value: unknown) =>
    quoteAmount(value) === null ? 'Unavailable' : `₹${quoteAmount(value)}`;
  return (
    <section className="checkout-section" aria-labelledby="checkout-items-title">
      <h3 id="checkout-items-title">Current checkout items</h3>
      <p className="caption">
        Quantity changes and removals (legacy ajax-cart set/delete) require a fresh final quote.
      </p>
      <div className="table-wrap">
        <table className="checkout-lines">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Unit price</th>
              <th scope="col">Sale unit price</th>
              <th scope="col">Quantity</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, complementary }, index) => (
              <tr
                className="checkout-current-line"
                key={`${complementary}:${item.prod_id}:${index}`}
              >
                <td>
                  <a
                    className="checkout-line-name"
                    title={item.product}
                    href={`/catalog/products/${item.parent_prod_id && item.parent_prod_id !== '0' ? item.parent_prod_id : item.prod_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.product}
                  </a>
                  {complementary && <span className="badge neutral">Complimentary</span>}
                </td>
                <td>{price(item.price)}</td>
                <td>{item.spl_price === undefined ? '—' : price(item.spl_price)}</td>
                {complementary ? (
                  <>
                    <td>{item.quantity}</td>
                    <td className="checkout-line-action">
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={disabled}
                        aria-label={`Remove complimentary ${item.product}`}
                        onClick={() =>
                          void act(async () => {
                            await mutate(`line-items/${item.prod_id}`, 'PUT', { quantity: 0 });
                          })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </>
                ) : (
                  <LineQuantity
                    productId={item.prod_id}
                    name={item.product}
                    quantity={item.quantity}
                    disabled={disabled}
                    act={act}
                    mutate={mutate}
                  />
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Legacy cart row quantity and remove (`create_order.html:1385`, `:1956`, `:2383`, `:2583`). */
function LineQuantity({
  productId,
  name,
  quantity,
  disabled,
  act,
  mutate,
}: {
  productId: string;
  name: string;
  quantity: number;
  disabled: boolean;
  act: (task: () => Promise<void>) => Promise<void>;
  mutate: (
    path: string,
    method: 'PUT' | 'POST',
    body?: Record<string, unknown>,
  ) => Promise<CheckoutReply>;
}) {
  const [value, setValue] = useState(String(quantity));
  const set = (next: number) =>
    void act(async () => {
      await mutate(`line-items/${productId}`, 'PUT', { quantity: next });
    });
  return (
    <>
      <td>
        <input
          className="checkout-line-quantity"
          type="number"
          min={0}
          max={999}
          step={1}
          value={value}
          disabled={disabled}
          aria-label={`Quantity of ${name}`}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            const next = Number(value);
            if (!Number.isInteger(next) || next < 0 || next > 999) {
              setValue(String(quantity));
              return;
            }
            if (next !== quantity) set(next);
          }}
        />
      </td>
      <td className="checkout-line-action">
        <button
          type="button"
          className="button secondary small"
          disabled={disabled}
          aria-label={`Remove ${name}`}
          onClick={() => set(0)}
        >
          Remove
        </button>
      </td>
    </>
  );
}
