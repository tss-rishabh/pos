import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { catalogService, type CatalogProductDto } from '../../src/modules/catalog.js';
import { createProductionTables } from '../helpers/production-schema.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

/**
 * Counter catalog (`catalogService.products` / `counters`) against the pinned source
 * (backend-pos-web 78d5b63) on one isolated MySQL fixture built from the production schema:
 * - products: `AjaxOrderProductsListView.datatables` (core/datatables/store_products_datatable.py:
 *   186-293) with the real core/stores models on Django 4.2.5 + PyMySQL; `Helpers.store_sellable_q`
 *   and `Helpers.get_erp_name` compiled from the pinned helpers/helpers.py; each row also carries the
 *   real `Product.first_image_url` (core/models.py:70-94).
 * - counters: the order tab's `StoreCounter.objects.filter(store_id, is_active=1)`
 *   (order/views.py:1454) rendered as `{{ c.counter_name }}` (order/templates/order/tab.html:112).
 * Replayed from `tests/golden/catalog/legacy-products-mysql.json`.
 *
 * Mapping: the source pages by `start`/`length` (DataTables) and the rewrite by an id cursor, so
 * page N of the source is compared with the rewrite page after the previous page's last id. Source
 * `"Barcode Missing"` is the rewrite's `null` barcode. Source prices are compared as the DataTables
 * column shows them (`String(value)` of the JSON value).
 */
const connection = process.env.MYSQL_INTEGRATION_URL;
const user: Principal = {
  id: '1',
  name: 'Synthetic operator',
  email: '',
  role: 1,
  userType: 1,
  storeIds: ['1', '2', '3'],
};
interface ProductsCase {
  kind: 'products';
  label: string;
  storeId: string;
  search: string;
  includeOutOfStock: boolean;
  start: number;
  length: number;
}
const products = (
  label: string,
  storeId: string,
  search: string,
  includeOutOfStock: boolean,
  start = 0,
  length = 30,
): ProductsCase => ({ kind: 'products', label, storeId, search, includeOutOfStock, start, length });
const productCases: ProductsCase[] = [
  products('in stock', '1', '', false),
  products('with out of stock', '1', '', true),
  products('page 1 of 3', '1', '', true, 0, 3),
  products('page 2 of 3', '1', '', true, 3, 3),
  products('page 3 of 3', '1', '', true, 6, 3),
  products('page 4 of 3', '1', '', true, 9, 3),
  products('accent and case insensitive name', '1', 'CAFE', false),
  products('id substring', '1', '10', true),
  products('barcode substring', '1', '8900000000002', true),
  products('literal percent', '1', '%', true),
  products('literal underscore', '1', '_', true),
  products('several matching barcodes', '1', '777', true),
  products('other store', '2', '', true),
];
const counterCases = ['1', '2', '3'].map((storeId) => ({ kind: 'counters' as const, storeId }));
const post = (item: ProductsCase) => ({
  'search[value]': item.search,
  'order[0][column]': '0',
  'order[0][dir]': 'asc',
  'columns[0][data]': 'id',
  store_id: item.storeId,
  include_oss_toggle: item.includeOutOfStock ? '1' : '0',
  start: String(item.start),
  draw: '1',
  length: String(item.length),
});
const sourceRow = z
  .object({
    id: z.number(),
    p_pid: z.number(),
    product: z.string(),
    prod_type: z.number(),
    erp_product: z.string(),
    barcode: z.union([z.number(), z.literal('Barcode Missing')]),
    stock: z.number(),
    holded_stock: z.number(),
    price: z.union([z.string(), z.number()]),
    storage_stock: z.string(),
    spl_price: z.union([z.string(), z.number()]),
    exclusive_price: z.union([z.string(), z.number()]),
    DT_RowId: z.number(),
    ParentProductId: z.number(),
    first_image_url: z.string().nullable(),
  })
  .strict();
const sourceSchema = z
  .object({
    sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
    results: z.array(
      z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('products'),
            response: z.object({
              draw: z.number(),
              recordsTotal: z.number(),
              recordsFiltered: z.number(),
              data: z.array(sourceRow),
            }),
          })
          .strict(),
        z
          .object({
            kind: z.literal('counters'),
            counters: z.array(z.object({ id: z.number(), label: z.string() }).strict()),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
/** One source row as the rewrite's counter-catalog DTO fields that have a source column. */
function expectedRow(row: z.infer<typeof sourceRow>) {
  return {
    id: String(row.id),
    name: row.product,
    erpName: row.erp_product,
    parentId: String(row.ParentProductId),
    type: String(row.prod_type),
    barcode: row.barcode === 'Barcode Missing' ? null : String(row.barcode),
    stock: row.stock,
    holdedStock: row.holded_stock,
    storageStock: row.storage_stock,
    price: String(row.price),
    specialPrice: String(row.spl_price),
    exclusivePrice: String(row.exclusive_price),
    image: row.first_image_url,
  };
}
const actualRow = (row: CatalogProductDto) => ({
  id: row.id,
  name: row.name,
  erpName: row.erpName,
  parentId: row.parentId,
  type: row.type,
  barcode: row.barcode,
  stock: row.stock,
  holdedStock: row.holdedStock,
  storageStock: row.storageStock,
  price: row.price,
  specialPrice: row.specialPrice,
  exclusivePrice: row.exclusivePrice,
  image: row.image,
});

describe.skipIf(!connection)('counter catalog against the pinned source on MySQL', () => {
  const schema = 'pos_v2_catalog_' + randomBytes(6).toString('hex');
  let admin: mysql.Connection | undefined, databases: Databases | undefined;
  let source: z.infer<typeof sourceSchema>;
  beforeAll(async () => {
    const base = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(base.hostname))
      throw new Error('Catalog fixtures require a local MySQL host.');
    admin = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await admin.changeUser({ database: schema });
    await admin.query("SET SESSION sql_mode=''");
    await createProductionTables(admin, [
      'stores',
      'store_storages',
      'store_counters',
      'products',
      'product_store',
      'products_gs1',
      'pricelist',
      'hold_stock_store',
      'stock_storages',
    ]);
    for (const [id, name] of [
      [1, 'Main store'],
      [2, 'Other store'],
      [3, 'Empty store'],
    ] as const)
      await admin.query(
        "INSERT INTO stores (id,store_name,phone,type,is_active,location_code,category) VALUES (?,?,?,'STORE',1,?,'IN_HOUSE')",
        [id, name, '900000000' + String(id), 'L' + id],
      );
    // [id, name, erp, parent, type, price, special, is_del, images_new]
    const catalog: [
      number,
      string,
      string | null,
      number,
      number,
      string,
      string,
      number,
      string,
    ][] = [
      [100, 'Root Tee', 'ROOT-ERP', 0, 3, '999.00', '799.00', 0, '{"unisex":["root.jpg"]}'],
      [101, 'Root Tee - S', '', 100, 1, '0.00', '0.00', 0, '{}'],
      [102, 'Root Tee - M', 'OWN-ERP', 100, 1, '0.00', '0.00', 0, '{"male":["own.jpg"]}'],
      [103, 'Café Mug', 'MUG-ERP', 0, 1, '349.50', '299.00', 0, '{"female":["mug.jpg"]}'],
      [104, 'Deleted out of stock', 'DEL-ERP', 0, 1, '10.00', '9.00', 1, '{}'],
      [105, 'Deleted in stock', null, 0, 1, '20.00', '19.00', 1, 'not json'],
      [106, 'Deleted root', 'DROOT-ERP', 0, 3, '50.00', '45.00', 1, '{"unisex":["droot.jpg"]}'],
      [107, 'Deleted root - S', '', 106, 1, '0.00', '0.00', 0, '{}'],
      [108, 'Deleted root - M', '', 106, 1, '0.00', '0.00', 0, '{}'],
      [109, '', 'BLANK-ERP', 0, 1, '1.00', '1.00', 0, '{}'],
      [110, 'Unavailable here', '', 0, 1, '1.00', '1.00', 0, '{}'],
      [111, 'Removed here', '', 0, 1, '1.00', '1.00', 0, '{}'],
      [112, 'Orphan variant', '', 999, 1, '5.00', '4.00', 0, '{}'],
      [113, 'Dup Hoodie', 'HOOD-ERP', 0, 1, '1499.00', '1299.00', 0, '{"unisex":["h.jpg"]}'],
      [114, '100% Cotton', '', 0, 1, '599.00', '499.00', 0, '{}'],
      [115, 'Under_score', '', 0, 1, '1.00', '1.00', 0, '{}'],
      [116, 'Root kid', 'KID-ERP', 0, 2, '199.00', '149.00', 0, '{}'],
    ];
    for (const [id, name, erp, parent, type, price, special, deleted, images] of catalog)
      await admin.query(
        `INSERT INTO products (id,product,erp_product,parent_prod_id,prod_type,price,spl_price,gst,is_del,images_new,
           target_date,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,12,?,?,'2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00')`,
        [id, name, erp, parent, type, price, special, deleted, images],
      );
    // [id, product, store, stock, is_avail, is_del]
    let link = 0;
    for (const [product, store, stock, available, removed] of [
      [100, 1, 9, 1, 0],
      [101, 1, 5, 1, 0],
      [102, 1, 0, 1, 0],
      [103, 1, 2, 1, 0],
      [104, 1, 0, 1, 0],
      [105, 1, 4, 1, 0],
      [107, 1, 0, 1, 0],
      [108, 1, 3, 1, 0],
      [109, 1, 3, 1, 0],
      [110, 1, 3, 0, 0],
      [111, 1, 3, 1, 1],
      [112, 1, 1, 1, 0],
      [113, 1, 1, 1, 0],
      [114, 1, 1, 1, 0],
      [115, 1, 0, 1, 0],
      [116, 1, 7, 1, 0],
      [101, 2, 2, 1, 0],
      [103, 2, 0, 1, 0],
    ] as const)
      await admin.query(
        'INSERT INTO product_store (id,product_id,store_id,stock,is_avail,is_del) VALUES (?,?,?,?,?,?)',
        [++link, product, store, stock, available, removed],
      );
    // products_gs1: the first row is chosen by primary key, not by the smallest GTIN.
    for (const [id, product, gtin] of [
      [49, 101, 8900000000002],
      [50, 101, 8900000000001],
      [51, 113, 7770001],
      [52, 113, 7770002],
      [53, 105, 1234567890123],
    ] as const)
      await admin.query('INSERT INTO products_gs1 (id,product_id,gtin) VALUES (?,?,?)', [
        id,
        product,
        gtin,
      ]);
    for (const [product, list, location, price] of [
      [100, 2, 0, 899],
      [103, 2, 0, 279.5],
      [103, 1, 0, 111],
      [113, 3, 0, 1],
    ] as const)
      await admin.query(
        'INSERT INTO pricelist (product_id,pricelist_id,location_id,price) VALUES (?,?,?,?)',
        [product, list, location, price],
      );
    for (const [id, product, store, stock] of [
      [60, 101, 1, 2],
      [61, 101, 1, 9],
      [62, 103, 2, 4],
      [63, 113, 1, 0],
    ] as const)
      await admin.query(
        'INSERT INTO hold_stock_store (id,product_id,store_id,stock) VALUES (?,?,?,?)',
        [id, product, store, stock],
      );
    for (const [id, store, name] of [
      [7, 1, 'Rack A'],
      [8, 1, 'Back room'],
      [9, 1, ''],
    ] as const)
      await admin.query(
        "INSERT INTO store_storages (id,store_id,storage_name,storage_type,is_active) VALUES (?,?,?,'STORAGE',1)",
        [id, store, name],
      );
    for (const [id, storage, store, product, stock] of [
      [70, 7, 1, 101, 3],
      [71, 8, 1, 101, 2],
      [72, 9, 1, 103, 0],
      [73, 7, 2, 103, 5],
    ] as const)
      await admin.query(
        'INSERT INTO stock_storages (id,storage_id,store_id,product_id,stock) VALUES (?,?,?,?,?)',
        [id, storage, store, product, stock],
      );
    for (const [id, store, name, active] of [
      [31, 1, 'C1', 1],
      [32, 1, '', 1],
      [33, 1, 'C3', 0],
      [34, 1, 'Front desk', 1],
      [35, 2, 'C1', 1],
    ] as const)
      await admin.query(
        "INSERT INTO store_counters (id,store_id,counter_name,counter_type,is_active) VALUES (?,?,?,'IN_STORE',?)",
        [id, store, name, active],
      );
    base.pathname = '/' + schema;
    const url = base.href;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'catalog-legacy-products-'.repeat(3),
        MYSQL_WRITER_URL: url,
        MYSQL_PRIMARY_READER_URL: url,
        MYSQL_DATA_READER_URL: url,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      }),
    );
    source = sourceSchema.parse(
      JSON.parse(
        goldenStdout(
          'catalog',
          'legacy-products-mysql',
          JSON.stringify({
            operation: 'datatable',
            database: url,
            cases: [
              ...productCases.map((item) => ({ kind: 'products', post: post(item) })),
              ...counterCases,
            ],
          }),
          undefined,
          fixturePlaceholders(url),
        ),
      ) as unknown,
    );
    expect(source.results).toHaveLength(productCases.length + counterCases.length);
  });
  afterAll(async () => {
    await databases?.close();
    await admin?.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
    await admin?.end();
  });

  async function rewritePage(item: ProductsCase) {
    const service = catalogService(databases!);
    let after = '0';
    let page = await service.products(
      user,
      item.storeId,
      item.search,
      after,
      item.length,
      item.includeOutOfStock,
    );
    for (let offset = item.length; offset <= item.start; offset += item.length) {
      if (page.nextCursor === null) return { data: [], nextCursor: null };
      after = page.nextCursor;
      page = await service.products(
        user,
        item.storeId,
        item.search,
        after,
        item.length,
        item.includeOutOfStock,
      );
    }
    return page;
  }
  function sourcePage(index: number) {
    const result = source.results[index]!;
    if (result.kind !== 'products') throw new Error('Expected a products result.');
    return result.response;
  }

  /** Money columns compared by value; their text form is checked separately below. */
  const byValue = <
    T extends { price: string; specialPrice: string; exclusivePrice: string | null },
  >(
    row: T,
  ) => ({
    ...row,
    price: Number(row.price),
    specialPrice: Number(row.specialPrice),
    exclusivePrice: Number(row.exclusivePrice),
  });
  /**
   * The source search joins `products_gs1` (`pb_product__gtin__icontains` in a separate
   * `filter()`), so a product with N barcode rows is listed N times whenever any branch of the
   * search matches. The rewrite searches with EXISTS and lists each product once
   * (parity/administration.md, catalog paragraph). Compared after keeping each source id once.
   */
  const firstOfEachId = <T extends { id: string }>(rows: T[]) =>
    rows.filter((row, index) => rows.findIndex((other) => other.id === row.id) === index);
  const duplicatedBySearch = new Set(['id substring', 'several matching barcodes']);

  for (const [index, item] of productCases.entries())
    it(`lists the same products as AjaxOrderProductsListView: ${item.label}`, async () => {
      const page = await rewritePage(item);
      const expected = sourcePage(index).data.map(expectedRow);
      if (duplicatedBySearch.has(item.label))
        expect(firstOfEachId(expected).length).toBeLessThan(expected.length);
      expect(page.data.map(actualRow).map(byValue)).toEqual(firstOfEachId(expected).map(byValue));
    });

  // Parity mismatch (display text only): where the source has no value it returns the integer 0
  // (`get_price`/`get_spl_price`/`get_exclusive_price`, store_products_datatable.py:314-331), which
  // the DataTables column shows as "0"; the rewrite returns "0.00" (catalog.ts:116-117 coalesce of a
  // DECIMAL(8,2), catalog.ts:323 exclusivePrice null -> '0.00'). Values are equal (checked above).
  it.fails('shows missing prices as the source does ("0")', async () => {
    const page = await rewritePage(productCases[1]!);
    expect(page.data.map(actualRow)).toEqual(sourcePage(1).data.map(expectedRow));
  });

  it('lists the same active counters, in id order, as the order tab', async () => {
    const service = catalogService(databases!);
    for (const [offset, item] of counterCases.entries()) {
      const result = source.results[productCases.length + offset]!;
      if (result.kind !== 'counters') throw new Error('Expected a counters result.');
      const actual = await service.counters(user, item.storeId);
      expect(actual.map((counter) => counter.id)).toEqual(
        result.counters.map((counter) => String(counter.id)),
      );
    }
  });
  // Parity mismatch: the order tab renders `{{ c.counter_name }}` (tab.html:112), so a blank
  // counter_name shows as an empty option; the rewrite falls back to the counter id
  // (catalog.ts:92 `r.name || String(r.id)`).
  it.fails('labels counters as the order tab renders counter_name', async () => {
    const service = catalogService(databases!);
    for (const [offset, item] of counterCases.entries()) {
      const result = source.results[productCases.length + offset]!;
      if (result.kind !== 'counters') throw new Error('Expected a counters result.');
      const actual = await service.counters(user, item.storeId);
      expect(actual.map((counter) => counter.name)).toEqual(
        result.counters.map((counter) => counter.label),
      );
    }
  });
});
