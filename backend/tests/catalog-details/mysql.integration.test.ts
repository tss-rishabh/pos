import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  productSearchInput,
  auditSearchInput,
} from '../../src/modules/catalog-details/contracts.js';
import { catalogDetailsService } from '../../src/modules/catalog-details/service.js';
import { inventoryAuditService } from '../../src/modules/catalog-details/audit.js';
import { catalogSnapshotService } from '../../src/modules/catalog-details/snapshot.js';
import { catalogService } from '../../src/modules/catalog.js';
import { readCatalogBarcode } from '../../src/modules/catalog-barcode.js';
import {
  inventoryMatrixService,
  inventoryMatrixInput,
} from '../../src/modules/catalog-details/matrix.js';
import { clearCheckIn, seedCheckIn } from '../helpers/check-ins.js';
import { goldenStdout } from '../golden/load.js';

const integration = process.env.MYSQL_INTEGRATION_URL;
const oracleResponse = z.object({
  queries: z.array(z.string()),
  output: z.object({
    draw: z.number(),
    recordsTotal: z.number(),
    recordsFiltered: z.number(),
    data: z.array(z.record(z.string(), z.unknown())),
  }),
});
const principal: Principal = {
  id: '1',
  name: 'Fixture operator',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1', '2'],
};
describe.skipIf(!integration)(
  'catalog source differentials on isolated verified-schema MySQL',
  () => {
    const schema = `pos_rewrite_catalog_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    let connection: mysql.Connection | undefined,
      databases: Databases | undefined,
      created = false;
    const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'catalog-source-fixture-'.repeat(3),
    });
    const db = () => {
      if (!databases) throw new Error('Catalog fixture unavailable.');
      return databases;
    };
    const native = () => {
      if (!connection) throw new Error('Catalog fixture unavailable.');
      return connection;
    };
    it('resolves exact alternate barcodes without fuzzy matches or duplicate SKU multiplication', async () => {
      // The generic source fixture omits secondary indexes. Restore this saved
      // physical unique index for the existing POS catalog FORCE INDEX contract.
      await native().query(
        'CREATE UNIQUE INDEX uq_product_store ON product_store(product_id,store_id)',
      );
      try {
        const catalog = catalogService(db());
        const read = (barcode: string, store = '1') =>
          readCatalogBarcode(catalog, db(), principal, store, barcode);
        const alternate = await read('0009007199254740994');
        expect(alternate).toMatchObject({
          matchedBarcode: '9007199254740994',
          product: {
            id: '11',
            barcode: '9007199254740993',
            stock: 3,
            holdedStock: 0,
            storageStock: 'Not available in any storage',
          },
        });
        // store_products_datatable.py:276-312: first hold row and one line per storage row.
        await native().query(
          'INSERT INTO hold_stock_store(id,product_id,store_id,stock) VALUES(5,20,1,4),(6,20,1,9)',
        );
        await native().query(
          'INSERT INTO stock_storages(id,storage_id,store_id,product_id,stock) VALUES(8,7,1,20,1)',
        );
        try {
          const page = await catalog.products(principal, '1', 'Café', '0', 30, true);
          expect(page.data.find((row) => row.id === '20')).toMatchObject({
            holdedStock: 4,
            storageStock: 'Actual bin : 2\nLegacy storage ID : 1\n',
          });
        } finally {
          await native().query('DELETE FROM hold_stock_store');
          await native().query('DELETE FROM stock_storages WHERE id=8');
        }
        await expect(read('900719925474099')).rejects.toMatchObject({ code: 'BARCODE_NOT_FOUND' });
        await expect(read('9007199254740995')).rejects.toMatchObject({ code: 'BARCODE_NOT_FOUND' });
        await expect(read('9007199254740993', '3')).rejects.toMatchObject({
          code: 'STORE_ACCESS_DENIED',
        });
        await native().query(
          'INSERT INTO products_gs1(id,product_id,gtin,created_at,updated_at) VALUES(100,11,9007199254740994,NOW(),NOW())',
        );
        try {
          expect((await read('9007199254740994')).product.id).toBe('11');
          await native().query(
            'INSERT INTO products_gs1(id,product_id,gtin,created_at,updated_at) VALUES(101,30,9007199254740994,NOW(),NOW())',
          );
          await expect(read('9007199254740994')).rejects.toMatchObject({
            code: 'BARCODE_AMBIGUOUS',
          });
        } finally {
          await native().query('DELETE FROM products_gs1 WHERE id IN (100,101)');
        }
      } finally {
        await native().query('DROP INDEX uq_product_store ON product_store');
      }
    });
    beforeAll(async () => {
      const url = new URL(integration!);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname))
        throw new Error('Catalog fixtures require an isolated local MySQL server.');
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
      await connection.query(
        `CREATE DATABASE ${mysql.escapeId(schema)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
      );
      created = true;
      await connection.changeUser({ database: schema });
      await connection.query("SET SESSION sql_mode=REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY','')");
      const fixture = verifiedMysqlFixture(connection);
      await fixture.create([
        'products',
        'product_store',
        'product_types',
        'pricelist',
        'products_gs1',
        'has_categories',
        'categories',
        'stores',
        'add_desc',
        'pos_product_inventory_logs',
        'pos_hold_stock_logs',
        'stock_storage_logs',
        'stock_storages',
        'store_storages',
        'hold_stock_store',
        'users',
        'pos_user',
        'user_stores',
      ]);
      for (const [id, name, type, active] of [
        [1, 'Alpha', 'STORE', 1],
        [2, 'Beta', 'STORE', 1],
        [3, 'Inactive', 'STORE', 0],
        [4, 'Warehouse', 'WAREHOUSE', 1],
        [5, 'Core', 'CORE_WAREHOUSE', 1],
      ] as const)
        await fixture.insert('stores', {
          id,
          store_name: name,
          type,
          is_active: active,
          category: id === 1 ? 'FRANCHISE' : 'IN_HOUSE',
        });
      await fixture.insert('pos_user', {
        id: 1,
        first_name: 'Fixture',
        last_name: 'Operator',
        is_active: 1,
        role: 1,
        user_type: 1,
      });
      await fixture.insert('pos_user', {
        id: 2,
        first_name: 'Other',
        last_name: 'Operator',
        is_active: 1,
        role: 3,
        user_type: 2,
      });
      await fixture.insert('user_stores', { django_user_id: 2, store_id: 1 });
      await seedCheckIn('1', '2');
      await seedCheckIn('2', '1');
      for (const [id, type] of [
        [1, 'Simple'],
        [3, 'Configurable'],
        [5, 'Digital'],
      ] as const)
        await fixture.insert('product_types', { id, type });
      const products = [
        [10, 'Blue cotton', 'ERP blue', 3, 0, 0],
        [11, 'Blue S', 'ERP S', 1, 10, 0],
        [12, 'Blue M', 'ERP M', 1, 10, 1],
        [13, 'Blue L', 'ERP L', 1, 10, 1],
        [20, 'Café red', 'ERP red', 1, 0, 0],
        [30, 'Deleted stocked', 'ERP stocked', 1, 0, 1],
        [40, 'Deleted family', 'ERP family', 3, 0, 1],
        [41, 'Family S', 'ERP FS', 1, 40, 1],
        [42, 'Family M', 'ERP FM', 1, 40, 0],
        [50, 'Digital item', 'ERP digital', 5, 0, 0],
        [60, '', 'ERP blank', 1, 0, 0],
        [70, 'Orphan variant', 'ERP orphan', 1, 99, 0],
        [80, 'Deleted empty', 'ERP empty', 1, 0, 1],
      ] as const;
      for (const [id, product, erp, type, parent, deleted] of products)
        await fixture.insert('products', {
          id,
          product,
          erp_product: erp,
          prod_type: type,
          parent_prod_id: parent,
          is_del: deleted,
          price: String(id) + '.00',
          spl_price: String(id - 1) + '.00',
          url_key: `url-${id}`,
          add_desc_id: 1,
          short_desc: '<p>Fixture short</p>',
          images_new: '{"male":["one.jpg"],"female":["two.jpg"]}',
        });
      await fixture.insert('add_desc', {
        id: 1,
        name: 'Fixture description',
        desc: '<b>Fixture long</b>',
        material: 'Cotton',
      });
      for (const [id, product, store, stock, deleted, available] of [
        [1, 10, 1, 0, 1, 0],
        [2, 10, 2, 0, 0, 1],
        [3, 11, 1, 3, 0, 1],
        [4, 12, 2, 4, 0, 1],
        [5, 13, 1, 0, 0, 1],
        [6, 20, 1, 0, 0, 1],
        [7, 20, 2, 0, 1, 1],
        [8, 30, 1, 5, 0, 1],
        [9, 30, 2, 0, 0, 1],
        [10, 40, 1, 0, 0, 1],
        [11, 40, 2, 0, 0, 1],
        [12, 41, 1, 4, 0, 1],
        [13, 42, 2, 0, 0, 1],
        [14, 50, 1, 1, 0, 1],
        [15, 60, 1, 1, 0, 1],
        [16, 70, 1, 1, 0, 1],
        [17, 80, 1, 0, 0, 1],
      ] as const)
        await fixture.insert('product_store', {
          id,
          product_id: product,
          store_id: store,
          stock,
          is_del: deleted,
          is_avail: available,
        });
      await fixture.insert('pricelist', {
        product_id: 10,
        pricelist_id: 2,
        location_id: 1,
        price: 8.25,
      });
      await fixture.insert('pricelist', {
        product_id: 10,
        pricelist_id: 2,
        location_id: 2,
        price: 8.25,
      });
      await fixture.insert('pricelist', {
        product_id: 20,
        pricelist_id: 2,
        location_id: 1,
        price: 0,
      });
      for (const [id, product, gtin] of [
        [1, 11, '9007199254740993'],
        [2, 11, '9007199254740994'],
        [3, 12, '9007199254740995'],
        [4, 20, '0'],
      ] as const)
        await fixture.insert('products_gs1', { id, product_id: product, gtin });
      await fixture.insert('categories', { id: 1, category: 'Cotton' });
      await fixture.insert('categories', { id: 2, category: 'Blue' });
      for (const [id, product, category] of [
        [1, 10, 1],
        [2, 10, 2],
        [3, 10, 1],
        [4, 20, 2],
      ] as const)
        await fixture.insert('has_categories', { id, prod_id: product, cat_id: category });
      await fixture.insert('users', { id: 1, firstname: 'Customer', lastname: 'Fixture' });
      await fixture.insert('store_storages', {
        id: 7,
        store_id: 1,
        storage_name: 'Legacy storage ID',
        is_active: 1,
      });
      await fixture.insert('store_storages', {
        id: 9,
        store_id: 1,
        storage_name: 'Actual bin',
        is_active: 1,
      });
      await fixture.insert('stock_storages', {
        id: 7,
        storage_id: 9,
        store_id: 1,
        product_id: 20,
        stock: 2,
      });
      for (const table of [
        'pos_product_inventory_logs',
        'pos_hold_stock_logs',
        'stock_storage_logs',
      ]) {
        for (const [id, store, before, after, date, pos] of [
          [1, 1, '3', '9', '2026-11-16 09:00:00', 1],
          [2, 2, '{"2":7,"1":3}', '{"1":2,"2":30}', '2026-11-16 10:00:00', 0],
          [3, 1, '4', '2', '2026-11-15 09:00:00', 999],
        ] as const) {
          await fixture.insert(table, {
            id,
            store_id: store,
            product_id: 20,
            stock_before: before,
            stock_after: after,
            user_id: 1,
            pos_user_id: pos,
            comment: 'Fixture comment',
            created_at: date,
            ...(table === 'stock_storage_logs'
              ? { storage_id: 7 }
              : table === 'pos_product_inventory_logs'
                ? { type: 1 }
                : {}),
          });
        }
      }
      await fixture.insert('products', {
        id: 90,
        product: 'Unassigned literal %_SKU',
        erp_product: 'ERP unassigned',
        prod_type: 1,
        parent_prod_id: 0,
        is_del: 0,
      });
      url.pathname = '/' + schema;
      config.MYSQL_WRITER_URL = url.toString();
      config.MYSQL_PRIMARY_READER_URL = url.toString();
      config.MYSQL_DATA_READER_URL = url.toString();
      config.MYSQL_ALLOW_LOCAL_PLAINTEXT = true;
      databases = createDatabases(config);
    });
    afterAll(async () => {
      await databases?.close();
      if (connection) {
        if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
        await connection.end();
      }
    });
    type SourceVector = { kind: string; parameters: Record<string, unknown> };
    const sourceOutputs = new Map<string, z.infer<typeof oracleResponse>['output']>();
    const sourceKey = (kind: string, parameters: Record<string, unknown>) =>
      JSON.stringify([kind, parameters]);
    function sourceParameters(
      kind: string,
      input: {
        storeIds: string[];
        search: string;
        sort: string;
        direction: string;
        start: number;
        draw: number;
        length: number;
      },
    ) {
      return {
        'selected_stores[]': input.storeIds,
        ...(kind === 'catalog' ? {} : { product_id: 20 }),
        'search[value]': input.search,
        'order[0][column]': '0',
        'order[0][dir]': input.direction,
        'columns[0][data]':
          kind === 'storage' && input.sort === 'product' ? 'product_name' : input.sort,
        start: input.start,
        draw: input.draw,
        length: input.length,
      };
    }
    function oracleBatch(values: unknown[]) {
      return z
        .array(oracleResponse)
        .parse(
          JSON.parse(
            goldenStdout(
              'catalog-details',
              'mysql-integration.source-oracle',
              JSON.stringify(values),
            ),
          ) as unknown,
        );
    }
    async function prepareSourceTables(vectors: SourceVector[]) {
      sourceOutputs.clear();
      const plans = oracleBatch(vectors),
        projected: unknown[] = [];
      expect(plans).toHaveLength(vectors.length);
      for (const [index, vector] of vectors.entries()) {
        const results: Array<{ columns: string[]; rows: unknown[][] }> = [];
        for (const statement of plans[index]!.queries) {
          const prefix =
            vector.kind === 'product' ? 'ppil' : vector.kind === 'held' ? 'phsl' : 'ssll';
          const scoped =
            vector.kind === 'catalog'
              ? statement
              : statement.replace(
                  /order by /i,
                  `and ${prefix}.created_at>='2026-11-16 00:00:00' and ${prefix}.created_at<='2026-11-16 23:59:59' order by `,
                );
          const [rows, fields] = await native().query<mysql.RowDataPacket[]>(scoped);
          results.push({
            columns: fields.map((field) => field.name),
            rows: rows.map((row) => fields.map((field) => row[field.name] as unknown)),
          });
        }
        projected.push({ ...vector, results, users: { 1: 'Fixture Operator' } });
      }
      const completed = oracleBatch(projected);
      expect(completed).toHaveLength(vectors.length);
      completed.forEach((value, index) => {
        value.output.data = value.output.data.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, entry]) => [
              key,
              ['id', 'product_id', 'DT_RowId'].includes(key) && entry !== null
                ? String(entry)
                : entry,
            ]),
          ),
        );
        const vector = vectors[index]!;
        sourceOutputs.set(sourceKey(vector.kind, vector.parameters), value.output);
      });
    }
    function sourceTable(kind: string, parameters: Record<string, unknown>) {
      const output = sourceOutputs.get(sourceKey(kind, parameters));
      if (!output) throw new Error('Source vector was not prepared.');
      return output;
    }
    it('preserves all list columns, distinct category/store aggregation, filtered totals and source paging', async () => {
      const catalog = catalogDetailsService(config, db());
      const vectors = (
        [
          'id',
          'product',
          'erp_product',
          'prod_type',
          'categories',
          'price',
          'exclusive_price',
          'store_names',
          'spl_price',
        ] as const
      ).flatMap((sort) =>
        (['asc', 'desc'] as const).map((direction) =>
          productSearchInput.parse({ storeIds: ['1', '2'], sort, direction, length: 2, start: 0 }),
        ),
      );
      for (const [search, start] of [
        ['blue', 2],
        ['url-30', 999],
        ['Simple', 1],
        ['cafe', 0],
        ['%', 0],
        ["' OR 1=1 --", 0],
      ] as const)
        vectors.push(
          productSearchInput.parse({ storeIds: ['1', '2'], search, sort: 'id', length: 2, start }),
        );
      await prepareSourceTables(
        vectors.map((input) => ({
          kind: 'catalog',
          parameters: sourceParameters('catalog', input),
        })),
      );
      expect(vectors).toHaveLength(24);
      for (const input of vectors) {
        const expected = sourceTable('catalog', sourceParameters('catalog', input)),
          actual = await catalog.search(principal, input);
        expect(actual.data).toEqual(expected.data);
        expect(actual.recordsTotal).toBe(expected.recordsTotal);
        expect(actual.recordsFiltered).toBe(expected.recordsFiltered);
      }
    }, 20000);
    it('preserves every product/held/storage audit row field and first-value JSON delta', async () => {
      const audit = inventoryAuditService(config, db(), {}, undefined, () =>
        Temporal.Instant.from('2026-11-16T08:00:00Z'),
      );
      const vectors = (['product', 'held', 'storage'] as const).flatMap((kind) =>
        (['id', 'store_name', 'product_id', 'product', 'created_at'] as const).flatMap((sort) =>
          (['asc', 'desc'] as const).map((direction) => ({
            kind,
            input: auditSearchInput.parse({
              storeIds: ['1', '2'],
              from: '2026-11-16T00:00:00',
              to: '2026-11-16T23:59:59',
              sort,
              direction,
              length: 2,
            }),
          })),
        ),
      );
      await prepareSourceTables(
        vectors.map(({ kind, input }) => ({ kind, parameters: sourceParameters(kind, input) })),
      );
      expect(vectors).toHaveLength(30);
      for (const { kind, input } of vectors) {
        const expected = sourceTable(kind, sourceParameters(kind, input)),
          actual = await audit.search(principal, '20', kind, input);
        expect(actual.recordsTotal).toBe(expected.recordsTotal);
        expect(actual.recordsFiltered).toBe(expected.recordsFiltered);
        for (const [index, row] of expected.data.entries())
          expect(actual.data[index]).toMatchObject(row);
      }
      const rows = await audit.search(
        principal,
        '20',
        'product',
        auditSearchInput.parse({
          storeIds: ['1', '2'],
          from: '2026-11-16T00:00:00',
          to: '2026-11-16T23:59:59',
        }),
      );
      expect(rows.data.map((row) => row.added_reduced)).toEqual([6, -5]);
      expect(rows.recordsTotal).toBe(2);
      const storage = await audit.search(
        principal,
        '20',
        'storage',
        auditSearchInput.parse({
          storeIds: ['1'],
          from: '2026-11-16T00:00:00',
          to: '2026-11-16T23:59:59',
        }),
      );
      expect(storage.data[0]?.storage_name).toBe('Legacy storage ID');
    }, 20000);
    it('loads live variants, source zipped barcodes, ordered check-in stock and description without per-cell queries', async () => {
      const catalog = catalogDetailsService(config, db()),
        result = await catalog.detail(principal, '10');
      const sourceTables: Record<string, unknown[]> = {};
      for (const table of [
        'products',
        'product_store',
        'products_gs1',
        'add_desc',
        'pricelist',
        'stores',
        'user_stores',
      ])
        sourceTables[table] = (
          await native().query<mysql.RowDataPacket[]>(
            `SELECT * FROM ${mysql.escapeId(table)} ORDER BY ${table === 'pricelist' ? 'product_id,pricelist_id,location_id' : 'id'}`,
          )
        )[0];
      const [liveVariants] = await native().query<mysql.RowDataPacket[]>(
        'SELECT p.id FROM products p WHERE p.parent_prod_id=10 AND (p.is_del=0 OR p.id IN(SELECT ps.product_id FROM product_store ps JOIN products v ON v.id=ps.product_id WHERE v.parent_prod_id=10 AND ps.is_del=0 AND ps.stock>0)) ORDER BY p.id',
      );
      const expected = z
        .object({
          variants: z.array(
            z.object({ id: z.string(), name: z.string(), barcode: z.string().nullable() }),
          ),
          stores: z.array(z.string()),
          stock: z.array(
            z.object({ productId: z.string(), storeId: z.string(), stock: z.number() }),
          ),
          exclusivePrice: z.number().nullable(),
          description: z.object({
            name: z.string(),
            description: z.string(),
            material: z.string(),
          }),
          male: z.array(z.string()),
          female: z.array(z.string()),
          checkInRequired: z.boolean(),
        })
        .parse(
          JSON.parse(
            goldenStdout(
              'catalog-details',
              'mysql-integration.detail-oracle',
              JSON.stringify({
                productId: '10',
                user: principal,
                checkedInStoreId: '2',
                tables: sourceTables,
                liveVariantIds: liveVariants.map((row) => String(row.id)),
              }),
            ),
          ) as unknown,
        );
      expect(result.variants).toEqual(expected.variants);
      expect(result.product).toMatchObject({
        exclusivePrice: expected.exclusivePrice,
        description: expected.description,
        male: expected.male,
        female: expected.female,
      });
      expect([...result.stores.map((row) => row.id)].sort()).toEqual([...expected.stores].sort());
      expect(result.stores[0]?.id).toBe(expected.stores[0]);
      expect(result.checkInRequired).toBe(expected.checkInRequired);
      for (const row of expected.stock)
        expect(
          result.stock.find(
            (value) => value.productId === row.productId && value.storeId === row.storeId,
          )?.stock || 0,
        ).toBe(row.stock);
      expect(result.variants).toEqual([
        { id: '11', name: 'Blue S', barcode: '9007199254740993' },
        { id: '12', name: 'Blue M', barcode: null },
      ]);
      expect(result.stores.map((row) => row.id)).toEqual(['2', '1', '5', '4']);
      expect(result.product.description.material).toBe('Cotton');
      expect(result.product.exclusivePrice).toBe(8.25);
      const franchise = {
        ...principal,
        id: '2',
        role: 3 as const,
        userType: 2 as const,
        storeIds: ['1'],
      };
      const scoped = await catalog.detail(franchise, '10');
      expect(scoped.stores.map((row) => row.id)).toEqual(['1']);
      expect(scoped.stock.every((row) => row.storeId === '1')).toBe(true);
      await clearCheckIn('2');
      const empty = await catalog.detail(franchise, '10');
      expect(empty.checkInRequired).toBe(true);
      expect(empty.stock).toEqual([]);
      await expect(
        catalog.search({ ...franchise, role: 1 }, productSearchInput.parse({ storeIds: ['2'] })),
      ).rejects.toMatchObject({ status: 403 });
    });
    it('builds the distinct offline seven-column profile, resolves repeated prices as legacy and keeps exact IDs', async () => {
      const snapshot = await catalogSnapshotService(db()).read(principal, '1');
      expect(snapshot.data).toEqual([
        ['11', 'Blue S', '9007199254740994', '10.00', '9.00', 8.25, 3],
        ['20', 'Café red', 'Barcode Missing', '20.00', '19.00', 0, 0],
        ['30', 'Deleted stocked', 'Barcode Missing', '30.00', '29.00', 0, 5],
        ['41', 'Family S', 'Barcode Missing', '40.00', '39.00', 0, 4],
        ['50', 'Digital item', 'Barcode Missing', '50.00', '49.00', 0, 1],
        ['70', 'Orphan variant', 'Barcode Missing', null, null, 0, 1],
      ]);
      const fixture = verifiedMysqlFixture(native());
      await fixture.insert('products', {
        id: '9007199254740993',
        product: 'Large ID',
        prod_type: 1,
        parent_prod_id: 0,
        is_del: 0,
        price: '99.00',
        spl_price: '90.00',
      });
      await fixture.insert('product_store', {
        product_id: '9007199254740993',
        store_id: 1,
        stock: 1,
        is_del: 0,
        is_avail: 1,
      });
      const large = await catalogDetailsService(config, db()).search(
        principal,
        productSearchInput.parse({ storeIds: ['1'], search: 'Large ID' }),
      );
      expect(large.data[0]?.id).toBe('9007199254740993');
      await fixture.insert('pricelist', {
        product_id: 20,
        pricelist_id: 2,
        location_id: 2,
        price: 1,
      });
      await expect(
        catalogDetailsService(config, db()).search(
          principal,
          productSearchInput.parse({ storeIds: ['1'], search: 'Café' }),
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_PRICE_RECONCILIATION_REQUIRED' });
      // Legacy AjaxCatalogueView keeps the last pricelist-2 row (core/views.py:1704-1709).
      expect(
        (await catalogSnapshotService(db()).read(principal, '1')).data.find(
          (row) => row[0] === '20',
        )?.[5],
      ).toBe(1);
    });
    it('preserves the full all-SKU stock matrix, source ERP inheritance and literal ORM search semantics', async () => {
      const [products] = await native().query<mysql.RowDataPacket[]>(
          'SELECT * FROM products ORDER BY id',
        ),
        [stock] = await native().query<mysql.RowDataPacket[]>(
          'SELECT * FROM product_store ORDER BY id',
        ),
        matrix = inventoryMatrixService(db());
      const vectors = (['id', 'product', 'erp_product'] as const).flatMap((sort) =>
        (['asc', 'desc'] as const).flatMap((direction) =>
          [0, 1, 999].map((start) =>
            inventoryMatrixInput.parse({
              storeIds: ['1', '2'],
              search: 'Blue',
              sort,
              direction,
              start,
              length: 1,
            }),
          ),
        ),
      );
      const expected = z
        .array(
          z.object({
            draw: z.number(),
            recordsTotal: z.number(),
            recordsFiltered: z.number(),
            data: z.array(z.record(z.string(), z.unknown())),
          }),
        )
        .parse(
          JSON.parse(
            goldenStdout(
              'catalog-details',
              'mysql-integration.matrix-oracle',
              JSON.stringify({
                products,
                stock,
                parameterCases: vectors.map((input) => sourceParameters('matrix', input)),
              }),
            ),
          ) as unknown,
        );
      expect(vectors).toHaveLength(18);
      expect(expected).toHaveLength(18);
      for (const [index, input] of vectors.entries()) {
        const source = expected[index]!,
          actual = await matrix.search(principal, input);
        expect(actual.recordsTotal).toBe(source.recordsTotal);
        expect(actual.recordsFiltered).toBe(source.recordsFiltered);
        for (const [rowIndex, value] of source.data.entries()) {
          const normalized = {
            ...value,
            id: String(value.id),
            DT_RowId: String(value.DT_RowId),
            ParentProductId: String(value.ParentProductId),
            stores: (value.stores as number[]).map(String),
          };
          expect(actual.data[rowIndex]).toMatchObject(normalized);
        }
      }
      const missing = await matrix.search(
        principal,
        inventoryMatrixInput.parse({ storeIds: ['1', '2'], search: '%_' }),
      );
      expect(missing.data).toMatchObject([
        {
          id: '90',
          stores: [],
          product_store_stock: [],
          product_store_stock_is_avail: [],
          product_store_stock_is_del: [],
        },
      ]);
      const scoped = await matrix.search(
        { ...principal, role: 3, storeIds: ['1'] },
        inventoryMatrixInput.parse({ storeIds: ['1'], search: 'Blue' }),
      );
      expect(scoped.stores.map((store) => store.id)).toEqual(['1']);
      expect(scoped.data.every((row) => row.stores.every((id) => id === '1'))).toBe(true);
      await expect(
        matrix.search(principal, inventoryMatrixInput.parse({ storeIds: ['1'], search: 'Orphan' })),
      ).rejects.toMatchObject({ code: 'CATALOG_PARENT_RECONCILIATION_REQUIRED' });
    }, 20000);
  },
);
