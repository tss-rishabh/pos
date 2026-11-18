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
  return (
    <section aria-label="Current checkout items">
      <h3>Current checkout items</h3>
      <p className="caption">
        These are the pricing service's current items. Changes require a fresh final quote.
      </p>
      {[
        ...lines.products.map((item) => ({ item, complementary: false })),
        ...lines.complementary.map((item) => ({ item, complementary: true })),
      ].map(({ item, complementary }, index) => (
        <div className="checkout-current-line" key={`${complementary}:${item.prod_id}:${index}`}>
          <a
            href={`/catalog/products/${item.parent_prod_id && item.parent_prod_id !== '0' ? item.parent_prod_id : item.prod_id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {item.product}
          </a>
          <span>
            {complementary ? 'Complimentary · ' : ''}Quantity {item.quantity}
          </span>
          <span>
            Unit price:{' '}
            {quoteAmount(item.price) === null ? 'Unavailable' : `₹${quoteAmount(item.price)}`}
          </span>
          {item.spl_price !== undefined && (
            <span>
              Sale unit price:{' '}
              {quoteAmount(item.spl_price) === null
                ? 'Unavailable'
                : `₹${quoteAmount(item.spl_price)}`}
            </span>
          )}
          {complementary && (
            <button
              type="button"
              className="button secondary"
              disabled={disabled}
              aria-label={`Remove complimentary ${item.product}`}
              onClick={() =>
                void act(async () => {
                  await mutate(`line-items/${item.prod_id}`, 'PUT', { quantity: 0 });
                })
              }
            >
              Remove complimentary item
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
