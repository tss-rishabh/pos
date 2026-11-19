import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
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
import { catalogService } from '../../src/modules/catalog.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

/**
 * W26: the counter's in-stock page pins `product_store.idx_store_id_stock_is_avail_is_del`.
 * With `FORCE INDEX` a schema without that index (UAT) failed with ER_KEY_DOES_NOT_EXITS, which
 * took down the counter catalogue, search and the offline catalogue cache. The optimizer-hint
 * form `INDEX(product_store idx_…)` must:
 *   1. produce exactly the FORCE INDEX plan where the index exists (production shape);
 *   2. return identical pages when the index is missing (only the access path changes).
 */
const template = process.env.MYSQL_INTEGRATION_URL;
const INDEX = 'idx_store_id_stock_is_avail_is_del';
const user: Principal = {
  id: '1',
  name: 'Synthetic operator',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1', '2'],
};
interface PlanTable {
  table_name?: string;
  access_type?: string;
  key?: string;
}
/** Every table entry in an EXPLAIN FORMAT=JSON document, in document order. */
function planTables(node: unknown, out: PlanTable[] = []): PlanTable[] {
  if (Array.isArray(node)) for (const item of node) planTables(item, out);
  else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record['table'] && typeof record['table'] === 'object') {
      const table = record['table'] as PlanTable & Record<string, unknown>;
      out.push({ table_name: table.table_name, access_type: table.access_type, key: table.key });
    }
    for (const [key, value] of Object.entries(record)) if (key !== 'table') planTables(value, out);
    if (record['table']) planTables(record['table'], out);
  }
  return out;
}

describe.skipIf(!template)('in-stock catalog page: INDEX optimizer hint (W26)', () => {
  let connection: mysql.Connection, pool: mysql.Pool, databases: Databases, schema: string;
  const statements: { sql: string; params: unknown[] }[] = [];
  let capturing: Databases;
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_integration'
    )
      throw new Error('Explicit isolated local pos_rewrite_integration template required.');
    schema = 'pos_catalog_hint_' + randomUUID().replaceAll('-', '').slice(0, 12);
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
    // A store holding most of a 600-product catalog, a fifth in stock, plus a second store.
    for (let id = 1; id <= 600; id++) {
      await fixture.insert('products', {
        id,
        product: id % 9 ? `Tee ${id}` : `Hoodie ${id}`,
        parent_prod_id: id % 5 === 0 ? 0 : 0,
        prod_type: 1,
        is_del: id % 31 ? 0 : 1,
        erp_product: `ERP-${id}`,
        price: 300 + id,
        spl_price: 0,
        images_new: '{}',
      });
      if (id % 10 !== 0)
        await fixture.insert('product_store', {
          store_id: 1,
          product_id: id,
          stock: id % 5 === 0 ? 0 : id % 5 === 1 ? id % 7 : 0,
          is_avail: id % 17 ? 1 : 0,
          is_del: id % 23 ? 0 : 1,
        });
      if (id % 3 === 0)
        await fixture.insert('product_store', { store_id: 2, product_id: id, stock: 2 });
    }
    await connection.query('ANALYZE TABLE product_store, products');
    const target = Object.assign(new URL(url), { pathname: '/' + schema }).href;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'catalog-index-hint-characterisation-'.repeat(2),
        MYSQL_WRITER_URL: target,
        MYSQL_PRIMARY_READER_URL: target,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_POOL_SIZE: '2',
      }),
    );
    pool = mysql.createPool({ uri: target, supportBigNumbers: true, bigNumberStrings: true });
    const logged = drizzle(pool, {
      logger: { logQuery: (query, params) => statements.push({ sql: query, params }) },
    });
    capturing = { get: () => logged, close: async () => undefined } as unknown as Databases;
  }, 120000);
  afterAll(async () => {
    await databases?.close();
    await pool?.end();
    if (connection) {
      await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
      await connection.end();
    }
  });

  const inputs = [
    ['1', '', '0', 20],
    ['1', '', '0', 3],
    ['1', '', '121', 5],
    ['1', 'Hoodie', '0', 10],
    ['1', 'zzz', '0', 10],
    ['2', '', '0', 50],
  ] as const;
  async function pages(service = catalogService(databases)) {
    const out = [];
    for (const [store, search, after, limit] of inputs)
      out.push(await service.products(user, store, search, after, limit, false));
    return out;
  }
  async function explain(statement: { sql: string; params: unknown[] }) {
    const [rows] = (await connection.query(
      'EXPLAIN FORMAT=JSON ' + statement.sql,
      statement.params,
    )) as [{ EXPLAIN: string }[], unknown];
    const [warnings] = (await connection.query('SHOW WARNINGS')) as [
      { Level: string; Code: number; Message: string }[],
      unknown,
    ];
    return { tables: planTables(JSON.parse(rows[0]!.EXPLAIN)), warnings };
  }
  /** The same statement as before W26: FORCE INDEX on the derived page's product_store. */
  const forceIndexForm = (text: string) => {
    const hinted = text.replace(` INDEX(product_store ${INDEX})`, '');
    expect(hinted).not.toBe(text);
    const forced = hinted.replace(
      /(\/\*\+ JOIN_ORDER\(product_store, products\) \*\/[\s\S]*?from `product_store`)/,
      `$1 force index (${INDEX})`,
    );
    expect(forced).not.toBe(hinted);
    return forced;
  };

  let withIndex: Awaited<ReturnType<typeof pages>>;
  it('with the index: the hinted statement has exactly the FORCE INDEX plan', async () => {
    withIndex = await pages();
    expect(withIndex[0]!.data.length).toBeGreaterThan(5);
    statements.length = 0;
    await catalogService(capturing).products(user, '1', '', '0', 20, false);
    const page = statements.find((entry) => entry.sql.includes(`INDEX(product_store ${INDEX})`));
    expect(page, 'the in-stock page statement carries the INDEX hint').toBeDefined();
    const hinted = await explain(page!);
    const forced = await explain({ sql: forceIndexForm(page!.sql), params: page!.params });
    expect(hinted.tables).toEqual(forced.tables);
    expect(hinted.tables).toContainEqual(
      expect.objectContaining({ table_name: 'product_store', key: INDEX }),
    );
    expect(hinted.warnings.filter((warning) => warning.Level !== 'Note')).toEqual([]);
  });

  it('without the index: identical pages, a hint warning instead of ER_KEY_DOES_NOT_EXITS', async () => {
    await connection.query(`ALTER TABLE product_store DROP INDEX ${INDEX}`);
    try {
      expect(await pages()).toStrictEqual(withIndex);
      statements.length = 0;
      await catalogService(capturing).products(user, '1', '', '0', 20, false);
      const page = statements.find((entry) => entry.sql.includes(`INDEX(product_store ${INDEX})`))!;
      const hinted = await explain(page);
      expect(hinted.tables.find((table) => table.table_name === 'product_store')?.key).not.toBe(
        INDEX,
      );
      expect(hinted.warnings.map((warning) => warning.Level)).toContain('Warning');
      // The pre-W26 statement fails on this schema (what UAT showed).
      await expect(connection.query(forceIndexForm(page.sql), page.params)).rejects.toMatchObject({
        code: 'ER_KEY_DOES_NOT_EXITS',
      });
    } finally {
      await connection.query(
        `ALTER TABLE product_store ADD INDEX ${INDEX} (store_id, stock, is_avail, is_del)`,
      );
    }
  });
});
