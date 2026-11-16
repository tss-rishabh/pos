import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { operationHash } from '../crypto.js';
import type { Cart, CheckoutState } from '../contracts.js';
import {
  copyManifestSchema,
  type CopyManifest,
  type CopyFacts,
  type CopyReview,
} from './contracts.js';

function id(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw invalid();
  return identifier.parse(String(value));
}
const invalid = () =>
  new AppError(502, 'ORDER_COPY_CART_INVALID', 'The current cart cannot be safely copied.');
/** Only this locally raised guard proves no mutating cart call was dispatched. */
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
export function draftOriginHash(
  state: Pick<CheckoutState, 'draftId' | 'draftVersion' | 'draftImport'>,
  secret: string,
): string {
  if (
    !state.draftId ||
    state.draftVersion == null ||
    !state.draftImport ||
    state.draftImport.status !== 'complete'
  )
    throw new AppError(
      409,
      'ORDER_COPY_DRAFT_REQUIRED',
      'Finish the original saved sale before copying an order.',
    );
  return operationHash(
    'order-copy.origin.v1',
    {
      draftId: state.draftId,
      draftVersion: state.draftVersion,
      lineItems: state.draftImport.lineItems,
    },
    secret,
  );
}
export function copySteps(facts: CopyFacts, before: CopyManifest): CopyReview['steps'] {
  const quantities = new Map<string, number>();
  for (const line of before)
    if (line.kind !== 'complementary')
      quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);
  const rows = new Map<string, string[]>();
  for (const line of facts.lines)
    rows.set(line.productId, [...(rows.get(line.productId) ?? []), line.lineId]);
  if (new Set([...quantities.keys(), ...rows.keys()]).size > 500)
    throw new AppError(422, 'ORDER_COPY_TOO_LARGE', 'The combined cart has too many products.');
  return [...rows]
    .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))
    .map(([productId, sourceLineIds]) => {
      const beforeQuantity = quantities.get(productId) ?? 0,
        targetQuantity = beforeQuantity + sourceLineIds.length;
      if (targetQuantity > 999)
        throw new AppError(
          422,
          'ORDER_COPY_QUANTITY_LIMIT',
          'A copied quantity exceeds the cart limit.',
        );
      return {
        id: crypto.randomUUID(),
        productId,
        sourceLineIds,
        beforeQuantity,
        targetQuantity,
        status: 'not-dispatched' as const,
        errorCode: null,
      };
    });
}
export function assertCopiedStep(before: Cart, after: Cart, productId: string, quantity: number) {
  const totals = (cart: Cart) => {
    const values = new Map<string, number>();
    for (const line of copyManifest(cart))
      if (line.kind !== 'complementary')
        values.set(line.productId, (values.get(line.productId) ?? 0) + line.quantity);
    return values;
  };
  const expected = totals(before),
    actual = totals(after);
  expected.set(productId, quantity);
  if (
    expected.size !== actual.size ||
    [...expected].some(([key, value]) => actual.get(key) !== value)
  )
    throw new AppError(
      409,
      'ORDER_COPY_RESULT_UNCONFIRMED',
      'The copied quantities need reconciliation. Do not repeat this addition.',
    );
  // Existing gift instances must survive; a copied card is a new unassigned
  // instance, never the old order's funded serial or PIN.
  const oldIds = copyManifest(before)
    .filter((line) => line.kind === 'gift-card')
    .map((line) => line.identity);
  const newIds = new Set(
    copyManifest(after)
      .filter((line) => line.kind === 'gift-card')
      .map((line) => line.identity),
  );
  if (oldIds.some((value) => !newIds.has(value))) throw invalid();
}
