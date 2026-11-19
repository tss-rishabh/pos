import { and, asc, eq, exists, gt, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import {
  HoldStockStore,
  Product,
  ProductBarcode,
  ProductStore,
  PriceList,
  StockStorage,
  Store,
  StoreCounter,
  StoreStorage,
} from '../db/legacy-schema.js';
import type { Databases } from '../db/pools.js';
import { requireStore, type Principal } from '../domain/access.js';
import type { CounterDto, Page, ProductDto, StoreDto } from '../domain/contracts.js';

const cdn = 'https://prod-img.thesouledstore.com/public/theSoul/uploads/catalog/product/';
export function firstProductImage(imagesNew: string | null): string | null {
  try {
    const images = JSON.parse(imagesNew || '{}') as Record<string, unknown>;
    for (const key of ['unisex', 'male', 'female']) {
      const values = images[key];
      if (Array.isArray(values) && typeof values[0] === 'string') return cdn + values[0];
    }
  } catch {
    /* Legacy malformed image metadata renders a placeholder. */
  }
  return null;
}
/** Source: Product.first_image_url prefers an own image before the variant's parent. */
export function productImage(
  imagesNew: string | null,
  parentImagesNew: string | null,
): string | null {
  return firstProductImage(imagesNew) || firstProductImage(parentImagesNew);
}

/**
 * Counter product row: the shared ProductDto plus the legacy `holded_stock` and `storage_stock`
 * columns (core/datatables/store_products_datatable.py:276-312). Optional in the type only so
 * other CatalogService implementations (demo) still compile; the MySQL service always sets them.
 */
export type CatalogProductDto = ProductDto & { holdedStock?: number; storageStock?: string };
/** `get_storage_stock`: one `"<storage> : <n>\n"` line per stock_storages row, in id order. */
export function legacyStorageStock(rows: readonly { name: string | null; stock: number }[]) {
  const text = rows.map((row) => `${row.name ?? 'None'} : ${row.stock}\n`).join('');
  return text || 'Not available in any storage';
}

export function catalogService(databases: Databases) {
  return {
    async stores(user: Principal): Promise<StoreDto[]> {
      const global = user.role === 1 && user.userType === 1;
      if (!global && user.storeIds.length === 0) return [];
      const rows = await databases
        .get('primary')
        .select({
          id: Store.id,
          name: Store.store_name,
          location: Store.location_code,
          city: Store.city_name,
          active: Store.is_active,
        })
        .from(Store)
        .where(
          and(
            eq(Store.is_active, true),
            global ? undefined : inArray(Store.id, user.storeIds.map(BigInt)),
            user.userType === 2 ? eq(Store.category, 'FRANCHISE') : undefined,
          ),
        )
        .orderBy(asc(Store.store_name));
      return rows.map((r) => ({
        id: String(r.id),
        name: r.name || String(r.id),
        // Legacy physical rows permit NULL despite the source model declaration.
        // The bootstrap DTO uses a display label; inventory uses its native data.
        locationCode: r.location ?? '',
        city: r.city || '',
        active: Boolean(r.active),
      }));
    },
    async counters(user: Principal, storeId: string): Promise<CounterDto[]> {
      requireStore(user, storeId);
      const rows = await databases
        .get('primary')
        .select({ id: StoreCounter.id, name: StoreCounter.counter_name })
        .from(StoreCounter)
        .where(and(eq(StoreCounter.store, BigInt(storeId)), eq(StoreCounter.is_active, true)))
        .orderBy(asc(StoreCounter.id));
      return rows.map((r) => ({ id: String(r.id), storeId, name: r.name || String(r.id) }));
    },
    async products(
      user: Principal,
      storeId: string,
      search = '',
      after = '0',
      limit = 30,
      includeOutOfStock = false,
      exactBarcode?: string,
    ): Promise<Page<CatalogProductDto>> {
      requireStore(user, storeId);
      const parent = alias(Product, 'catalog_parent');
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      // Barcode and membership prices are bounded scalar projections; the outer
      // stock join never multiplies rows when a SKU has multiple GS1 records.
      const rows = await databases
        .get('primary')
        .select({
          id: sql<bigint>`/*+ JOIN_ORDER(products, product_store) */ ${Product.id}`,
          name: Product.product,
          erp: sql<string>`coalesce(nullif(case when ${Product.parent_prod_id}=0 then ${Product.erp_product} else ${parent.erp_product} end,''),'-')`,
          parentId: Product.parent_prod_id,
          type: Product.prod_type,
          price: sql<string>`case when ${Product.parent_prod_id}=0 then ${Product.price} else coalesce(${parent.price},0) end`,
          special: sql<string>`case when ${Product.parent_prod_id}=0 then ${Product.spl_price} else coalesce(${parent.spl_price},0) end`,
          gst: Product.gst,
          images: Product.images_new,
          parentImages: parent.images_new,
          stock: ProductStore.stock,
          barcode: sql<string | null>`${databases
            .get('primary')
            .select({ gtin: ProductBarcode.gtin })
            .from(ProductBarcode)
            .where(eq(ProductBarcode.product, Product.id))
            .orderBy(asc(ProductBarcode.id))
            .limit(1)}`,
          exclusive: sql<string | null>`${databases
            .get('primary')
            .select({ price: PriceList.price })
            .from(PriceList)
            .where(
              and(
                eq(
                  PriceList.product_id,
                  sql`case when ${Product.parent_prod_id}=0 then ${Product.id} else ${Product.parent_prod_id} end`,
                ),
                eq(PriceList.pricelist_id, 2),
              ),
            )
            .orderBy(asc(PriceList.product_id))
            .limit(1)}`,
        })
        .from(Product, { forceIndex: 'PRIMARY' })
        .innerJoin(
          ProductStore,
          and(eq(ProductStore.product, Product.id), eq(ProductStore.store, BigInt(storeId))),
          { forceIndex: 'uq_product_store' },
        )
        .leftJoin(parent, eq(parent.id, Product.parent_prod_id))
        .where(
          and(
            eq(ProductStore.store, BigInt(storeId)),
            eq(ProductStore.is_del, false),
            eq(ProductStore.is_avail, true),
            includeOutOfStock ? undefined : gt(ProductStore.stock, 0),
            ne(Product.product, ''),
            or(
              and(
                eq(Product.is_del, 0),
                or(
                  isNull(parent.id),
                  ne(parent.is_del, 1),
                  ne(parent.prod_type, 3n),
                  ne(parent.parent_prod_id, 0n),
                ),
              ),
              gt(ProductStore.stock, 0),
            ),
            or(ne(Product.parent_prod_id, 0n), ne(Product.prod_type, 3n)),
            gt(Product.id, BigInt(after)),
            exactBarcode !== undefined
              ? exists(
                  databases
                    .get('primary')
                    .select({ id: ProductBarcode.id })
                    .from(ProductBarcode)
                    .where(
                      and(
                        eq(ProductBarcode.product, Product.id),
                        eq(ProductBarcode.gtin, BigInt(exactBarcode)),
                      ),
                    ),
                )
              : search
                ? or(
                    like(Product.product, pattern),
                    like(sql`cast(${Product.id} as char)`, pattern),
                    exists(
                      databases
                        .get('primary')
                        .select({ id: ProductBarcode.id })
                        .from(ProductBarcode)
                        .where(
                          and(
                            eq(ProductBarcode.product, Product.id),
                            like(ProductBarcode.gtin, pattern),
                          ),
                        ),
                    ),
                  )
                : undefined,
          ),
        )
        .orderBy(asc(Product.id))
        .limit(limit + 1);
      const more = rows.length > limit;
      const selected = rows.slice(0, limit),
        ids = selected.map((row) => BigInt(row.id)),
        holds = new Map<string, number>(),
        storages = new Map<string, { name: string | null; stock: number }[]>();
      if (ids.length) {
        // get_holded_stock: HoldStockStore.filter(product, store).first() (lowest id) or 0.
        for (const hold of await databases
          .get('primary')
          .select({ product: HoldStockStore.product, stock: HoldStockStore.stock })
          .from(HoldStockStore)
          .where(
            and(eq(HoldStockStore.store, BigInt(storeId)), inArray(HoldStockStore.product, ids)),
          )
          .orderBy(asc(HoldStockStore.id)))
          if (!holds.has(String(hold.product))) holds.set(String(hold.product), hold.stock);
        for (const storage of await databases
          .get('primary')
          .select({
            product: StockStorage.product,
            name: StoreStorage.storage_name,
            stock: StockStorage.stock,
          })
          .from(StockStorage)
          .innerJoin(StoreStorage, eq(StoreStorage.id, StockStorage.storage))
          .where(and(eq(StockStorage.store, BigInt(storeId)), inArray(StockStorage.product, ids)))
          .orderBy(asc(StockStorage.id))) {
          const key = String(storage.product);
          storages.set(key, [...(storages.get(key) ?? []), storage]);
        }
      }
      return {
        data: selected.map((r) => ({
          id: String(r.id),
          name: r.name,
          erpName: r.erp,
          parentId: String(r.parentId),
          type: String(r.type),
          price: r.price,
          specialPrice: r.special,
          exclusivePrice: r.exclusive === null ? '0.00' : String(r.exclusive),
          barcode: r.barcode === null ? null : String(r.barcode),
          stock: r.stock,
          holdedStock: holds.get(String(r.id)) ?? 0,
          storageStock: legacyStorageStock(storages.get(String(r.id)) ?? []),
          gst: r.gst,
          image: productImage(r.images, r.parentImages),
        })),
        nextCursor: more ? String(selected.at(-1)!.id) : null,
      };
    },
  };
}
export type CatalogService = ReturnType<typeof catalogService>;
