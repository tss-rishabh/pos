// Frozen pre-W11 copy (integration head 43613a75) of the raw-SQL implementation. Characterisation
// oracle only: tests/catalog-details/orm-characterisation.mysql.test.ts compares it with src.
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../src/config.js';
import type { Databases } from '../../../src/db/pools.js';
import {
  Product,
  ProductBarcode,
  ProductDescription,
  ProductStore,
  Store,
} from '../../../src/db/legacy-schema.js';
import type { Principal } from '../../../src/domain/access.js';
import { AppError } from '../../../src/domain/errors.js';
import { checkInService } from '../../../src/modules/administration/checkins.js';
import {
  countValue,
  productRow,
  productSearchInput,
  type ProductSearchInput,
} from '../../../src/modules/catalog-details/contracts.js';
import { catalogCountQuery, catalogPageQuery, catalogPriceConflictQuery } from './queries.js';
import {
  sourcePageStart,
  sourceProductImages,
} from '../../../src/modules/catalog-details/domain.js';

export function assertCatalogScope(user: Principal, ids: readonly string[]) {
  // A franchise account remains assigned-store scoped even if its role is elevated.
  if (user.userType === 2 && ids.some((id) => !user.storeIds.includes(id)))
    throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
}
export function catalogDetailsService(config: Config, db: Databases) {
  const checkins = checkInService(db, config);
  async function stores(user: Principal) {
    if (user.userType === 2 && !user.storeIds.length) return [];
    const rows = await db
      .get('primary')
      .select({ id: Store.id, name: Store.store_name, type: Store.type })
      .from(Store)
      .where(
        and(
          eq(Store.is_active, true),
          user.userType === 2 ? inArray(Store.id, user.storeIds.map(BigInt)) : undefined,
        ),
      )
      .orderBy(asc(Store.store_name), asc(Store.id))
      .limit(5001);
    if (rows.length > 5000)
      throw new AppError(422, 'CATALOG_SCOPE_TOO_LARGE', 'Select a smaller catalog store scope.');
    return rows.map((row) => ({ ...row, id: String(row.id), name: row.name || String(row.id) }));
  }
  return {
    async metadata(user: Principal) {
      const [data, checkedInStoreId] = await Promise.all([
        stores(user),
        checkins.checkedInStore(user.id),
      ]);
      return {
        data,
        selectedStoreIds:
          checkedInStoreId && data.some((store) => store.id === checkedInStoreId)
            ? [checkedInStoreId]
            : [],
        stockManagementPath: '/inventory',
      };
    },
    async search(user: Principal, value: ProductSearchInput) {
      const input = productSearchInput.parse(value);
      input.storeIds = [...new Set(input.storeIds)];
      assertCatalogScope(user, input.storeIds);
      if (!input.storeIds.length)
        return {
          reader: 'primary' as const,
          draw: input.draw,
          recordsTotal: 0,
          recordsFiltered: 0,
          unfilteredCount: 0,
          start: 0,
          data: [],
        };
      const active = await db
        .get('primary')
        .select({ id: Store.id })
        .from(Store)
        .where(and(inArray(Store.id, input.storeIds.map(BigInt)), eq(Store.is_active, true)));
      if (active.length !== input.storeIds.length)
        throw new AppError(
          400,
          'INACTIVE_CATALOG_STORE',
          'Select active stores from the catalog store list.',
        );
      const [counts] = z
        .array(z.object({ unfiltered_count: countValue, filtered_count: countValue }))
        .parse((await db.get('primary').execute(catalogCountQuery(input)))[0]);
      const filtered = counts?.filtered_count || 0,
        start = sourcePageStart(input.start, input.length, filtered);
      if (input.sort === 'exclusive_price') {
        const conflicts = (await db.get('primary').execute(catalogPriceConflictQuery(input)))[0];
        if (z.array(z.object({ conflict: z.coerce.number() })).parse(conflicts).length)
          throw new AppError(
            422,
            'CATALOG_PRICE_RECONCILIATION_REQUIRED',
            'A product has conflicting membership prices. Reconcile its location prices before continuing.',
          );
      }
      const rows = z
        .array(productRow.extend({ exclusive_price_choices: countValue }))
        .parse((await db.get('primary').execute(catalogPageQuery(input, start)))[0]);
      if (rows.some((row) => row.exclusive_price_choices > 1))
        throw new AppError(
          422,
          'CATALOG_PRICE_RECONCILIATION_REQUIRED',
          'A product has conflicting membership prices. Reconcile its location prices before continuing.',
        );
      return {
        reader: 'primary' as const,
        draw: input.draw,
        recordsTotal: filtered,
        recordsFiltered: filtered,
        unfilteredCount: counts?.unfiltered_count || 0,
        start,
        data: rows.map(({ exclusive_price_choices: _choices, ...row }) => ({
          ...row,
          DT_RowId: row.id,
        })),
      };
    },
    async detail(user: Principal, productId: string) {
      const [product] = await db
        .get('primary')
        .select({
          id: Product.id,
          name: Product.product,
          erpName: Product.erp_product,
          shortDescription: Product.short_desc,
          price: Product.price,
          specialPrice: Product.spl_price,
          descriptionId: Product.add_desc_id,
          images: Product.images_new,
          parentId: Product.parent_prod_id,
          type: Product.prod_type,
        })
        .from(Product)
        .where(eq(Product.id, BigInt(productId)))
        .limit(1);
      if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
      const [allStores, checkedInStoreId, variants, descriptions, prices] = await Promise.all([
        stores(user),
        checkins.checkedInStore(user.id),
        db
          .get('primary')
          .select({ id: Product.id, name: Product.product, parentId: Product.parent_prod_id })
          .from(Product)
          .where(
            and(
              eq(Product.parent_prod_id, product.id),
              or(
                eq(Product.is_del, 0),
                sql`exists(select 1 from ${ProductStore} where ${ProductStore.product}=${Product.id} and ${ProductStore.is_del}=0 and ${ProductStore.stock}>0)`,
              ),
            ),
          )
          .orderBy(asc(Product.id))
          .limit(1001),
        db
          .get('primary')
          .select({
            name: ProductDescription.name,
            description: ProductDescription.desc,
            material: ProductDescription.material,
          })
          .from(ProductDescription)
          .where(eq(ProductDescription.id, BigInt(product.descriptionId)))
          .limit(1),
        db
          .get('primary')
          .execute(
            sql`select min(price) as price,count(distinct price)+if(count(*)>count(price),1,0) as choices from pricelist where product_id=${productId} and pricelist_id=2`,
          ),
      ]);
      if (variants.length > 1000)
        throw new AppError(
          422,
          'CATALOG_FAMILY_TOO_LARGE',
          'Reconcile this unusually large product family before opening it.',
        );
      const [price] = z
        .array(z.object({ price: z.coerce.number().finite().nullable(), choices: countValue }))
        .parse(prices[0]);
      if ((price?.choices || 0) > 1)
        throw new AppError(
          422,
          'CATALOG_PRICE_RECONCILIATION_REQUIRED',
          'A product has conflicting membership prices. Reconcile its location prices before continuing.',
        );
      let visibleStores = allStores.filter((store) =>
        ['STORE', 'WAREHOUSE', 'CORE_WAREHOUSE'].includes(store.type || ''),
      );
      if (user.userType === 2)
        visibleStores = visibleStores.filter((store) => store.id === checkedInStoreId);
      visibleStores.sort(
        (a, b) => Number(b.id === checkedInStoreId) - Number(a.id === checkedInStoreId),
      );
      const family = variants.length
          ? variants
          : [{ id: product.id, name: product.name, parentId: product.parentId }],
        ids = family.map((row) => row.id);
      const [barcodes, stock] = await Promise.all([
        db
          .get('primary')
          .select({
            id: ProductBarcode.id,
            productId: ProductBarcode.product,
            gtin: ProductBarcode.gtin,
          })
          .from(ProductBarcode)
          .where(inArray(ProductBarcode.product, ids))
          .orderBy(asc(ProductBarcode.id))
          .limit(10001),
        visibleStores.length
          ? db
              .get('primary')
              .select({
                productId: ProductStore.product,
                storeId: ProductStore.store,
                stock: ProductStore.stock,
                available: ProductStore.is_avail,
                listed: ProductStore.is_del,
              })
              .from(ProductStore)
              .where(
                and(
                  inArray(ProductStore.product, ids),
                  inArray(
                    ProductStore.store,
                    visibleStores.map((row) => BigInt(row.id)),
                  ),
                ),
              )
              .limit(200001)
          : [],
      ]);
      if (barcodes.length > 10000 || stock.length > 200000)
        throw new AppError(
          422,
          'CATALOG_DETAIL_TOO_LARGE',
          'Select a smaller product family before opening its stock.',
        );
      // Source zips the two separately ordered querysets instead of joining by product ID.
      const zipped = new Map<string, string>();
      family.forEach((variant, index) => {
        const barcode = barcodes[index];
        if (barcode?.productId === variant.id) zipped.set(String(variant.id), String(barcode.gtin));
      });
      const { images: _images, descriptionId: _descriptionId, ...dto } = product;
      return {
        reader: 'primary' as const,
        product: {
          ...dto,
          id: String(dto.id),
          parentId: String(dto.parentId),
          type: String(dto.type),
          exclusivePrice: price?.price ?? null,
          ...sourceProductImages(product.images),
          description: descriptions[0] || { name: '', description: '', material: '' },
        },
        variants: family.map((row) => ({
          id: String(row.id),
          name: row.name,
          barcode: zipped.get(String(row.id)) || null,
        })),
        stores: visibleStores,
        stock: stock.map((row) => ({
          ...row,
          productId: String(row.productId),
          storeId: String(row.storeId),
          listed: !row.listed,
        })),
        checkInRequired: user.userType === 2 && !visibleStores.length,
        stockManagementPath: '/inventory',
      };
    },
  };
}
