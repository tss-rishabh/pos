import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import {
  and,
  asc,
  eq,
  exists,
  getTableName,
  gt,
  inArray,
  isNull,
  like,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  HoldStockStore,
  PriceList,
  Product,
  ProductBarcode,
  ProductStore,
  StockStorage,
  StoreStorage,
} from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import {
  catalogService,
  legacyStorageStock,
  productImage,
  type CatalogProductDto,
} from '../../src/modules/catalog.js';
import type { Page } from '../../src/domain/contracts.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

/**
 * W16 characterisation: the counter product page (`catalogService.products`) moved from a
 * `products` PRIMARY range (`JOIN_ORDER(products, product_store)`, FORCE INDEX PRIMARY) to a
 * derived page of product ids driven by this store's `product_store` index, or by the
 * `products_gs1.gtin` index for an exact barcode. The oracle below is the former statement
 * verbatim (3a3e0ab5 src/modules/catalog.ts:105-200). Every page must be identical: rows, order,
 * column values and types, and cursors.
 */
const template = process.env.MYSQL_INTEGRATION_URL;
const user: Principal = {
  id: '1',
  name: 'Synthetic operator',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1', '2', '3'],
};

async function formerRows(
  databases: Databases,
  storeId: string,
  search: string,
  after: string,
  limit: number,
  includeOutOfStock: boolean,
  exactBarcode?: string,
) {
  const parent = alias(Product, 'catalog_parent');
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  return databases
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
}

/** The former service body after its row query (unchanged by W16), applied to the oracle rows. */
async function formerPage(
  databases: Databases,
  storeId: string,
  search: string,
  after: string,
  limit: number,
  includeOutOfStock: boolean,
  exactBarcode?: string,
): Promise<Page<CatalogProductDto>> {
  const rows = await formerRows(
    databases,
    storeId,
    search,
    after,
    limit,
    includeOutOfStock,
    exactBarcode,
  );
  const more = rows.length > limit;
  const selected = rows.slice(0, limit),
    ids = selected.map((row) => BigInt(row.id)),
    holds = new Map<string, number>(),
    storages = new Map<string, { name: string | null; stock: number }[]>();
  if (ids.length) {
    for (const hold of await databases
      .get('primary')
      .select({ product: HoldStockStore.product, stock: HoldStockStore.stock })
      .from(HoldStockStore)
      .where(and(eq(HoldStockStore.store, BigInt(storeId)), inArray(HoldStockStore.product, ids)))
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
}

describe.skipIf(!template)('catalog product page plan (ORM characterisation)', () => {
  let connection: mysql.Connection, databases: Databases, schema: string;
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_integration' ||
      url.search ||
      url.hash
    )
      throw new Error('Explicit isolated local pos_rewrite_integration template required.');
    schema = 'pos_catalog_plan_' + randomUUID().replaceAll('-', '').slice(0, 12);
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection);
    await fixture.create(
      [
        Product,
        ProductStore,
        ProductBarcode,
        PriceList,
        HoldStockStore,
        StockStorage,
        StoreStorage,
      ].map(getTableName),
    );
    // id, name, parent, type, is_del, erp, price, special
    const products: [number, string, number, number, number, string, number, number][] = [
      [10, 'Plain 50% tee', 0, 1, 0, 'ERP-10', 799, 699],
      [11, 'Deleted simple', 0, 1, 1, '', 599, 0],
      [12, '', 0, 1, 0, 'ERP-12', 100, 90],
      [20, 'Live parent', 0, 3, 0, 'ERP-PARENT-20', 999, 899],
      [21, 'Live parent / S', 20, 1, 0, '', 0, 0],
      [22, 'Live parent / M', 20, 1, 1, 'ERP-OWN-22', 0, 0],
      [30, 'Retired parent', 0, 3, 1, 'ERP-PARENT-30', 1299, 1099],
      [31, 'Retired parent / S', 30, 1, 0, '', 0, 0],
      [32, 'Retired parent / M', 30, 1, 0, '', 0, 0],
      [40, 'Orphan variant_x', 9999, 1, 0, 'ERP-40', 0, 0],
      [41, 'Nested variant', 21, 1, 0, '', 0, 0],
      [50, 'Shared barcode one', 0, 1, 0, 'ERP-50', 500, 450],
      [51, 'Shared barcode two', 0, 1, 0, 'ERP-51', 501, 451],
      [60, 'Other store only', 0, 1, 0, 'ERP-60', 300, 250],
      [70, 'Configurable leaf', 0, 3, 0, 'ERP-70', 300, 250],
    ];
    for (const [id, product, parent, type, isDel, erp, price, special] of products)
      await fixture.insert('products', {
        id,
        product,
        parent_prod_id: parent,
        prod_type: type,
        is_del: isDel,
        erp_product: erp,
        price,
        spl_price: special,
        gst: id % 2 ? 5 : 12,
        images_new: id === 21 ? '{"male":["21.jpg"]}' : id === 20 ? '{"unisex":["20.jpg"]}' : '{}',
      });
    for (let id = 1000; id < 1040; id++)
      await fixture.insert('products', {
        id,
        product: `Bulk tee ${id}`,
        parent_prod_id: id % 3 ? 20 : 0,
        prod_type: 1,
        is_del: id % 7 ? 0 : 1,
        erp_product: id % 5 ? `ERP-${id}` : '',
        price: 100 + id,
        spl_price: 50 + id,
        images_new: '{}',
      });
    // store, product, stock, is_avail, is_del
    const stores: [number, number, number, number, number][] = [
      [1, 10, 3, 1, 0],
      [1, 11, 2, 1, 0],
      [1, 12, 5, 1, 0],
      [1, 20, 0, 1, 0],
      [1, 21, 4, 1, 0],
      [1, 22, 0, 1, 0],
      [1, 30, 0, 1, 0],
      [1, 31, 0, 1, 0],
      [1, 32, 6, 1, 0],
      [1, 40, 0, 1, 0],
      [1, 41, -1, 1, 0],
      [1, 50, 1, 1, 0],
      [1, 51, 0, 1, 0],
      [1, 70, 9, 1, 0],
      [2, 60, 8, 1, 0],
      [2, 10, 0, 1, 0],
      [2, 21, 2, 0, 0],
      [2, 50, 2, 1, 1],
    ];
    for (let id = 1000; id < 1040; id++)
      stores.push([1, id, id % 4 ? id % 6 : 0, id % 11 ? 1 : 0, id % 13 ? 0 : 1]);
    for (const [store, product, stock, avail, del] of stores)
      await fixture.insert('product_store', {
        store_id: store,
        product_id: product,
        stock,
        is_avail: avail,
        is_del: del,
      });
    for (const [id, product, gtin] of [
      [30, 10, '8901234567890'],
      [12, 21, '9007199254740993'],
      [11, 21, '4000000000001'],
      [40, 50, '7777777777777'],
      [41, 51, '7777777777777'],
      [42, 51, '7777777777777'],
      [43, 32, '1032'],
      [44, 60, '6000000000060'],
      [45, 1001, '8901234561001'],
      [46, 1013, '8901234561013'],
    ] as const)
      await fixture.insert('products_gs1', { id, product_id: product, gtin });
    for (const [product, location, price] of [
      [20, 0, 799],
      [20, 5, 749],
      [10, 0, 650],
      [50, 3, 400],
    ] as const)
      await fixture.insert('pricelist', {
        product_id: product,
        pricelist_id: 2,
        location_id: location,
        price,
      });
    await fixture.insert('pricelist', {
      product_id: 51,
      pricelist_id: 1,
      location_id: 0,
      price: 1,
    });
    await fixture.insert('store_storages', { id: 1, store_id: 1, storage_name: 'Back room' });
    for (const [product, stock] of [
      [21, 2],
      [21, 5],
      [10, 1],
    ] as const) {
      await fixture.insert('hold_stock_store', { product_id: product, store_id: 1, stock });
      await fixture.insert('stock_storages', {
        storage_id: 1,
        store_id: 1,
        product_id: product,
        stock,
      });
    }
    const target = Object.assign(new URL(url), { pathname: '/' + schema }).href;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'catalog-plan-characterisation-'.repeat(3),
        MYSQL_WRITER_URL: target,
        MYSQL_PRIMARY_READER_URL: target,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_POOL_SIZE: '4',
      }),
    );
  }, 60000);
  afterAll(async () => {
    await databases?.close();
    if (connection) {
      await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
      await connection.end();
    }
  });

  it('returns the same pages (rows, order, values, types, cursors) as the former statement', async () => {
    const service = catalogService(databases);
    let compared = 0,
      barcodes = 0,
      exclusive = 0;
    for (const store of ['1', '2', '3'])
      for (const includeOutOfStock of [false, true])
        for (const search of ['', 'tee', '50%', 'variant_x', '_', '10', '77777', '8901234', 'zzz'])
          for (const [after, limit] of [
            ['0', 1],
            ['0', 2],
            ['0', 30],
            ['21', 3],
            ['1005', 5],
            ['99999', 5],
          ] as const) {
            const actual = await service.products(
              user,
              store,
              search,
              after,
              limit,
              includeOutOfStock,
            );
            expect(actual).toStrictEqual(
              await formerPage(databases, store, search, after, limit, includeOutOfStock),
            );
            compared += actual.data.length;
            barcodes += actual.data.filter((row) => row.barcode !== null).length;
            exclusive += actual.data.filter((row) => row.exclusivePrice !== '0.00').length;
          }
    expect(compared).toBeGreaterThan(250);
    expect(barcodes).toBeGreaterThan(20);
    expect(exclusive).toBeGreaterThan(20);
  }, 120000);

  it('resolves exact barcodes to the same pages (shared, alternate, other-store, missing)', async () => {
    const service = catalogService(databases);
    let matched = 0;
    for (const store of ['1', '2', '3'])
      for (const includeOutOfStock of [false, true])
        for (const exact of [
          '7777777777777',
          '9007199254740993',
          '4000000000001',
          '1032',
          '6000000000060',
          '8901234561013',
          '5',
        ])
          for (const limit of [1, 2]) {
            const actual = await service.products(
              user,
              store,
              '',
              '0',
              limit,
              includeOutOfStock,
              exact,
            );
            expect(actual).toStrictEqual(
              await formerPage(databases, store, '', '0', limit, includeOutOfStock, exact),
            );
            matched += actual.data.length;
          }
    expect(matched).toBeGreaterThan(10);
  }, 60000);

  it('walks every page to the same complete sequence', async () => {
    const service = catalogService(databases);
    for (const includeOutOfStock of [false, true])
      for (const search of ['', 'tee']) {
        let cursor = '0',
          walked: CatalogProductDto[] = [];
        for (;;) {
          const page = await service.products(user, '1', search, cursor, 4, includeOutOfStock);
          walked = walked.concat(page.data);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        expect(walked).toStrictEqual(
          (await formerPage(databases, '1', search, '0', 1000, includeOutOfStock)).data,
        );
      }
  }, 60000);
});
