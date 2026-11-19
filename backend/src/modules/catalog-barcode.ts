import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Databases } from '../db/pools.js';
import { HoldStockStore, StockStorage, Store, StoreStorage } from '../db/legacy-schema.js';
import { authenticated } from '../auth/routes.js';
import { identifier } from '../domain/validation.js';
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

/** Legacy `get_storage_stock` text when a SKU has no storage rows (`store_products_datatable.py:312`). */
export const noStorageStock = 'Not available in any storage';
export interface CatalogStockLocation {
  productId: string;
  heldStock: number;
  storageStock: string;
}
const stockLocationQuery = z
  .object({
    productIds: z
      .string()
      .max(2100)
      .transform((value) => value.split(','))
      .pipe(z.array(identifier).min(1).max(100))
      .transform((ids) => [...new Set(ids)]),
  })
  .strict();

/**
 * Picker columns `holded_stock` and `storage_stock` of `AjaxOrderProductsListView`
 * (`core/datatables/store_products_datatable.py:277-280,300-312`) for one page of products.
 * `.first()` on an unordered queryset orders by primary key; the storage loop has no ORDER BY
 * and walks the `product_id` secondary index, which is primary-key order within one product.
 */
export function stockLocations(
  productIds: readonly string[],
  held: readonly { product: bigint; stock: number }[],
  storages: readonly { product: bigint; name: string; stock: number }[],
): CatalogStockLocation[] {
  const firstHeld = new Map<string, number>();
  for (const row of held)
    if (!firstHeld.has(String(row.product))) firstHeld.set(String(row.product), row.stock);
  const storageText = new Map<string, string>();
  for (const row of storages) {
    const key = String(row.product);
    storageText.set(key, `${storageText.get(key) ?? ''}${row.name} : ${row.stock}\n`);
  }
  return productIds.map((productId) => ({
    productId,
    heldStock: firstHeld.get(productId) ?? 0,
    storageStock: storageText.get(productId) || noStorageStock,
  }));
}

export async function readCatalogStockLocations(
  db: Databases | null,
  user: Principal,
  storeId: string,
  productIds: readonly string[],
): Promise<{ data: CatalogStockLocation[] }> {
  requireStore(user, storeId);
  if (!db) return { data: [] };
  const reader = db.get('primary'),
    ids = productIds.map(BigInt),
    store = BigInt(storeId);
  const [held, storages] = await Promise.all([
    reader
      .select({ product: HoldStockStore.product, stock: HoldStockStore.stock })
      .from(HoldStockStore)
      .where(and(eq(HoldStockStore.store, store), inArray(HoldStockStore.product, ids)))
      .orderBy(asc(HoldStockStore.id)),
    reader
      .select({
        product: StockStorage.product,
        name: StoreStorage.storage_name,
        stock: StockStorage.stock,
      })
      .from(StockStorage)
      .innerJoin(StoreStorage, eq(StoreStorage.id, StockStorage.storage))
      .where(and(eq(StockStorage.store, store), inArray(StockStorage.product, ids)))
      .orderBy(asc(StockStorage.id)),
  ]);
  return { data: stockLocations(productIds, held, storages) };
}

/** `GET /api/v1/stores/:storeId/catalog/stock-locations?productIds=1,2` (read-only, no PII). */
export function registerCatalogStockLocations(app: FastifyInstance, db: Databases | null) {
  app.get(
    '/api/v1/stores/:storeId/catalog/stock-locations',
    {
      config: { trace: { module: 'catalog', resource: 'product-stock-location', action: 'list' } },
    },
    async (request, reply) => {
      const user = authenticated(request);
      const { storeId } = z.object({ storeId: identifier }).strict().parse(request.params);
      const { productIds } = stockLocationQuery.parse(request.query);
      const result = await readCatalogStockLocations(db, user, storeId, productIds);
      return reply.header('Cache-Control', 'private, no-store').send(result);
    },
  );
}
