import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../db/pools.js';
import { Store } from '../db/legacy-schema.js';
import type { Principal } from '../domain/access.js';
import type { ProductDto } from '../domain/contracts.js';
import { AppError } from '../domain/errors.js';
import { requireStore } from '../domain/access.js';
import { assertCurrentStoreAccess } from './administration/authorization.js';
import type { CatalogService } from './catalog.js';

/** Physical GS1 GTIN is signed BIGINT. Preserve scanner precision and leading-zero equality. */
export const catalogBarcode = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^\d+$/)
  .refine((value) => /^\d{1,100}$/.test(value) && BigInt(value) <= 9223372036854775807n)
  .transform((value) => BigInt(value).toString());

export function uniqueBarcodeProduct(products: readonly ProductDto[], matchedBarcode: string) {
  const byId = new Map(products.map((product) => [product.id, product]));
  if (!byId.size)
    throw new AppError(404, 'BARCODE_NOT_FOUND', 'No sellable product matches this barcode.');
  if (byId.size !== 1)
    throw new AppError(
      409,
      'BARCODE_AMBIGUOUS',
      'This barcode matches multiple products. Reconcile the barcode before selling.',
    );
  return { matchedBarcode, product: [...byId.values()][0]! };
}

/** Exact EXISTS shares the catalog projection/eligibility, including alternate GS1 records. */
export async function readCatalogBarcode(
  catalog: CatalogService,
  db: Databases | null,
  user: Principal,
  storeId: string,
  raw: string,
) {
  const barcode = catalogBarcode.parse(raw);
  requireStore(user, storeId);
  // AjaxCart's falsy integer zero falls back to product_id=0; it does not query GTIN0.
  if (barcode === '0')
    throw new AppError(404, 'BARCODE_NOT_FOUND', 'No sellable product matches this barcode.');
  async function currentAuthority() {
    if (!db) return;
    await db.get('writer').transaction(async (tx) => {
      await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3, 4, 5], 'share');
      const [store] = await tx
        .select({ active: Store.is_active })
        .from(Store)
        .where(eq(Store.id, BigInt(storeId)))
        .limit(1)
        .for('share');
      if (!store?.active)
        throw new AppError(403, 'STORE_ACCESS_DENIED', 'This store is unavailable.');
    });
  }
  await currentAuthority();
  const page = db
    ? await catalog.products(user, storeId, '', '0', 2, false, barcode)
    : await catalog.products(user, storeId, barcode, '0', 100, false);
  const result = uniqueBarcodeProduct(
    db
      ? page.data
      : page.data.filter((product) => {
          const parsed = catalogBarcode.safeParse(product.barcode);
          return parsed.success && parsed.data === barcode;
        }),
    barcode,
  );
  await currentAuthority();
  return result;
}
