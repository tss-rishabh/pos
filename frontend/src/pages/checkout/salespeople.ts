import { z } from 'zod';
import { request } from '../../api/client';
import type { Checkout } from './client';

// Legacy order_stores/has_products use signed INT, while the directory uses BIGINT.
export const checkoutSalespersonId = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .refine((id) => /^[1-9]\d{0,9}$/.test(id) && BigInt(id) <= 2147483647n);
const productId = z
  .union([z.string().regex(/^[1-9]\d{0,18}$/), z.number().int().positive().safe()])
  .transform(String);
const pageSchema = z
  .object({
    data: z
      .array(z.object({ id: checkoutSalespersonId, name: z.string().max(500) }).strict())
      .max(100),
    nextCursor: checkoutSalespersonId.nullable(),
  })
  .strict()
  .refine((value) => new Set(value.data.map((person) => person.id)).size === value.data.length);

export const readCheckoutSalespeople = async (
  checkout: Pick<Checkout, 'storeId'>,
  operatorId: string,
  after: string,
  signal: AbortSignal,
) => {
  const cursor = after === '0' ? '0' : checkoutSalespersonId.parse(after);
  const page = await request(
    `/api/v1/stores/${encodeURIComponent(checkout.storeId)}/salespeople?purpose=checkout&active=true&after=${cursor}&limit=100`,
    { operatorId, signal },
    pageSchema,
  );
  if (page.nextCursor && BigInt(page.nextCursor) <= BigInt(cursor))
    throw new Error('The salesperson directory did not advance. Reload the directory.');
  return page;
};

export function checkoutSalespersonLines(checkout: Checkout) {
  const lines = new Map<string, { id: string; name: string }>();
  for (const item of [
    ...(checkout.cart?.products.items ?? []),
    ...(checkout.cart?.giftvouchers?.items ?? []),
    ...(checkout.cart?.complementary_products?.items ?? []),
  ]) {
    const parsed = productId.safeParse(item.prod_id);
    if (!parsed.success) throw new Error('A sale line has an invalid product reference.');
    const name = [item.product, item.name, item.title].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    lines.set(parsed.data, { id: parsed.data, name: name ?? `Product ${parsed.data}` });
  }
  return [...lines.values()];
}

/** The source cash form requires a master and a resolved assignment for every product. */
export function hasCashSalespeople(checkout: Checkout) {
  if (!checkoutSalespersonId.safeParse(checkout.salespersonId).success) return false;
  try {
    const lines = checkoutSalespersonLines(checkout);
    return (
      lines.length > 0 &&
      lines.every(
        (line) =>
          checkoutSalespersonId.safeParse(
            checkout.lineSalespersons?.[line.id] ?? checkout.salespersonId,
          ).success,
      )
    );
  } catch {
    return false;
  }
}
