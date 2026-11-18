import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { operationHash } from '../crypto.js';
import type { Cart } from '../contracts.js';
import { copyManifestSchema, type CopyManifest } from './contracts.js';

function id(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw invalid();
  return identifier.parse(String(value));
}
const invalid = () =>
  new AppError(502, 'ORDER_COPY_CART_INVALID', 'The current cart cannot be safely copied.');
/** Raised by the checkout cart helper before any mutating call when the cart moved underneath a copy step. */
export class OrderCopyPreflightError extends AppError {
  constructor() {
    super(
      409,
      'ORDER_COPY_BASE_CART_CHANGED',
      'The customer cart changed. Review its current contents before copying.',
    );
  }
}
export function copyManifest(cart: Cart): CopyManifest {
  const result: CopyManifest = [];
  for (const [kind, items] of [
    ['product', cart.products.items],
    ['gift-card', cart.giftvouchers?.items ?? []],
    ['complementary', cart.complementary_products?.items ?? []],
  ] as const) {
    for (const item of items) {
      const quantity = z
        .union([
          z.number(),
          z
            .string()
            .regex(/^[1-9]\d{0,2}$/)
            .transform(Number),
        ])
        .pipe(z.number().int().min(1).max(999))
        .safeParse(item.quantity ?? 1);
      if (!quantity.success) throw invalid();
      const rawPrice = item.price;
      if (
        rawPrice !== undefined &&
        rawPrice !== null &&
        !z
          .union([
            z.number().finite().nonnegative(),
            z
              .string()
              .regex(/^\d+(?:\.\d+)?$/)
              .max(64),
          ])
          .safeParse(rawPrice).success
      )
        throw invalid();
      result.push({
        productId: id(item.prod_id),
        quantity: quantity.data,
        kind,
        name: typeof item.product === 'string' ? item.product.slice(0, 300) : '',
        price: rawPrice === undefined || rawPrice === null ? null : String(rawPrice),
        identity: kind === 'gift-card' ? id(item.gv_id) : null,
      });
    }
  }
  const identities = result.map((line) => [line.kind, line.productId, line.identity].join(':'));
  if (new Set(identities).size !== identities.length) throw invalid();
  return copyManifestSchema.parse(
    result.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        (BigInt(a.productId) < BigInt(b.productId)
          ? -1
          : BigInt(a.productId) > BigInt(b.productId)
            ? 1
            : 0) ||
        (a.identity ?? '').localeCompare(b.identity ?? ''),
    ),
  );
}
export function cartCopyHash(cart: Cart, secret: string): string {
  // Include source metadata so an intervening benefit/selection change cannot
  // be overwritten by a reviewed stale cart. Never log this input.
  return operationHash(
    'order-copy.cart.v1',
    {
      lines: copyManifest(cart),
      meta: cart.meta ?? null,
      selected: cart.selected_products ?? null,
    },
    secret,
  );
}
