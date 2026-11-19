import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { and, asc, eq, getTableName, gt, like, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig, type Config } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { Product, ProductBarcode, ProductStore } from '../../src/db/legacy-schema.js';
import { inventoryService } from '../../src/modules/administration/inventory.js';
import type { AdminPage } from '../../src/modules/administration/service.js';
import type { Principal } from '../../src/domain/access.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

/**
 * W11 characterisation: the inventory list's first-barcode column moved from a hand-written
 * scalar sub-SELECT to a builder subquery. The oracle below is the former statement verbatim
 * (43613a75 src/modules/administration/inventory.ts:57-91).
 */
const template = process.env.ADMINISTRATION_MYSQL_TEST_URL;
describe.skipIf(!template)('inventory list first barcode (ORM characterisation)', () => {
  let connection: mysql.Connection, db: Databases, config: Config, schema: string;
  const user: Principal = {
    id: '1',
    name: 'Synthetic operator',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  };
  async function oracle(storeId: string, page: AdminPage) {
    const rows = await db
      .get('primary')
      .select({
        id: Product.id,
        name: Product.product,
        erpName: Product.erp_product,
        parentId: Product.parent_prod_id,
        type: Product.prod_type,
        stock: ProductStore.stock,
        available: ProductStore.is_avail,
        archived: ProductStore.is_del,
        barcode: sql<
          string | null
        >`(select ${ProductBarcode.gtin} from ${ProductBarcode} where ${ProductBarcode.product}=${Product.id} order by ${ProductBarcode.id} asc limit 1)`,
      })
      .from(ProductStore)
      .innerJoin(Product, eq(Product.id, ProductStore.product))
      .where(
        and(
          eq(ProductStore.store, BigInt(storeId)),
          gt(Product.id, BigInt(page.after)),
          page.active === 'all' ? undefined : eq(ProductStore.is_del, page.active === 'false'),
          page.search
            ? or(
                like(Product.product, `%${page.search.replace(/[\\%_]/g, '\\$&')}%`),
                eq(Product.id, /^\d+$/.test(page.search) ? BigInt(page.search) : 0n),
              )
            : undefined,
        ),
      )
      .orderBy(asc(Product.id))
      .limit(page.limit + 1);
    return {
      data: rows.slice(0, page.limit),
      nextCursor: rows.length > page.limit ? String(rows[page.limit - 1]!.id) : null,
    };
  }
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_administration_test' ||
      url.search ||
      url.hash
    )
      throw new Error('Explicit isolated local administration template required.');
    schema = 'pos_inventory_orm_' + randomUUID().replaceAll('-', '').slice(0, 12);
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
    await fixture.create([Product, ProductStore, ProductBarcode].map(getTableName));
    const products: [string, string][] = [
      ['5', 'Plain 50% tee'],
      ['6', 'No barcode'],
      ['7', 'Two barcodes'],
      ['8', 'Zero barcode first'],
      ['9007199254740993', 'Wide id_item'],
    ];
    for (const [id, name] of products) {
      await fixture.insert('products', { id, product: name });
      await fixture.insert('product_store', {
        product_id: id,
        store_id: 1,
        stock: id === '6' ? -2 : 3,
        is_avail: 1,
        is_del: id === '8' ? 1 : 0,
      });
    }
    await fixture.insert('product_store', { product_id: 7, store_id: 2, stock: 1 });
    for (const [id, product, gtin] of [
      [30, '5', '8901234567890'],
      [12, '7', '9007199254740993'],
      [11, '7', '4000000000001'],
      [40, '8', '0'],
      [41, '8', '123'],
      [50, '9007199254740993', '18446744073709551'],
    ] as const)
      await fixture.insert('products_gs1', { id, product_id: product, gtin });
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'inventory-orm-characterisation-'.repeat(3),
      MYSQL_WRITER_URL: Object.assign(new URL(url), { pathname: '/' + schema }).href,
      MYSQL_PRIMARY_READER_URL: Object.assign(new URL(url), { pathname: '/' + schema }).href,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_POOL_SIZE: '4',
    });
    db = createDatabases(config);
  }, 30000);
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
      await connection.end();
    }
  });

  it('returns the same rows, barcodes and cursors as the former raw sub-SELECT', async () => {
    const service = inventoryService(config, db);
    let compared = 0,
      barcodes = 0;
    for (const store of ['1', '2', '3'])
      for (const active of ['all', 'true', 'false'] as const)
        for (const search of ['', '50%', '_item', '7', '9007199254740993', 'barcode'])
          for (const [after, limit] of [
            ['0', 1],
            ['0', 2],
            ['5', 2],
            ['0', 50],
          ] as const) {
            const page = { after, limit, active, search } as AdminPage;
            const actual = await service.list(user, store, page);
            expect(actual).toStrictEqual(await oracle(store, page));
            compared += actual.data.length;
            barcodes += actual.data.filter((row) => row.barcode !== null).length;
          }
    expect(compared).toBeGreaterThan(60);
    expect(barcodes).toBeGreaterThan(30);
  }, 60000);
});
