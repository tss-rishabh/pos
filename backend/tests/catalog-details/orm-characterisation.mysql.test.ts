import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  auditSearchInput,
  productSearchInput,
  productSort,
  type AuditKind,
} from '../../src/modules/catalog-details/contracts.js';
import { catalogDetailsService } from '../../src/modules/catalog-details/service.js';
import { inventoryAuditService } from '../../src/modules/catalog-details/audit.js';
import { catalogSnapshotService } from '../../src/modules/catalog-details/snapshot.js';
import {
  inventoryMatrixInput,
  inventoryMatrixService,
} from '../../src/modules/catalog-details/matrix.js';
import { catalogService } from '../../src/modules/catalog.js';
import { catalogDetailsService as rawCatalogDetailsService } from './raw-oracle/service.js';
import { inventoryAuditService as rawInventoryAuditService } from './raw-oracle/audit.js';
import { catalogSnapshotService as rawCatalogSnapshotService } from './raw-oracle/snapshot.js';
import { inventoryMatrixService as rawInventoryMatrixService } from './raw-oracle/matrix.js';
import { catalogService as rawCatalogService } from './raw-oracle/catalog.js';
import { clearCheckIn, seedCheckIn } from '../helpers/check-ins.js';

/**
 * W11 characterisation: every catalog-details query (and the catalog counter search) runs through
 * the Drizzle query builder in `src`, while `raw-oracle/` keeps the frozen pre-conversion raw SQL.
 * Both run against the same synthetic seed; their complete outputs (rows, order, types, nulls,
 * errors) must be identical.
 */
const integration = process.env.MYSQL_INTEGRATION_URL;
const admin: Principal = {
  id: '1',
  name: 'Fixture operator',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1', '2', '4', '6'],
};
const franchise: Principal = {
  ...admin,
  id: '2',
  role: 3,
  userType: 2,
  storeIds: ['1'],
};
const scopedAdmin: Principal = { ...admin, id: '3', role: 3, storeIds: ['2'] };
type Settled = { ok: unknown } | { error: { status: unknown; code: unknown; message: unknown } };
async function settle(run: () => Promise<unknown>): Promise<Settled> {
  try {
    return { ok: await run() };
  } catch (error) {
    const value = error as { status?: unknown; code?: unknown; message?: unknown };
    return { error: { status: value.status, code: value.code, message: value.message } };
  }
}
function withoutClock(value: Settled): Settled {
  if (!('ok' in value) || !value.ok || typeof value.ok !== 'object') return value;
  const { syncedAt: _syncedAt, ...rest } = value.ok as Record<string, unknown>;
  return { ok: rest };
}

describe.skipIf(!integration)('catalog-details ORM conversion characterisation', () => {
  const schema = `pos_rewrite_catalog_orm_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let connection: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  const config = readConfig({
    NODE_ENV: 'test',
    MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
    SESSION_SECRET: 'catalog-orm-fixture-'.repeat(3),
  });
  const db = () => {
    if (!databases) throw new Error('Catalog fixture unavailable.');
    return databases;
  };
  const native = () => {
    if (!connection) throw new Error('Catalog fixture unavailable.');
    return connection;
  };
  let nonEmpty = 0;
  async function same(name: string, current: () => Promise<unknown>, raw: () => Promise<unknown>) {
    const expected = await settle(raw),
      actual = await settle(current);
    expect(actual, name).toEqual(expected);
    if ('ok' in expected) {
      const data = (expected.ok as { data?: unknown[] } | undefined)?.data;
      if (Array.isArray(data) && data.length) nonEmpty++;
    }
    return expected;
  }

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
      [6, '', 'STORE', 1],
    ] as const)
      await fixture.insert('stores', {
        id,
        store_name: name,
        phone: '9100000' + id,
        type,
        is_active: active,
        category: id === 1 ? 'FRANCHISE' : 'IN_HOUSE',
      });
    for (const [id, first, last] of [
      [1, 'Fixture', 'Operator'],
      [2, null, 'Only last'],
      [3, '  Spaced', null],
    ] as const)
      await fixture.insert('pos_user', {
        id,
        username: 'fixture-operator-' + id,
        first_name: first,
        last_name: last,
        is_active: 1,
        role: id === 2 ? 3 : 1,
        user_type: id === 2 ? 2 : 1,
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
    const products: [string, string, string | null, number, string, number, string, string][] = [
      ['10', 'Blue cotton', 'ERP blue', 3, '0', 0, '10.00', '9.00'],
      ['11', 'Blue S', 'ERP S', 1, '10', 0, '11.00', '10.00'],
      ['12', 'Blue M', '', 1, '10', 1, '12.00', '11.00'],
      ['13', 'Blue L', null, 1, '10', 1, '13.00', '12.00'],
      ['14', 'Blue XL', 'ERP XL', 1, '10', 0, '14.00', '13.00'],
      ['20', 'Café red', 'ERP red', 1, '0', 0, '20.00', '19.00'],
      ['21', 'cafe RED', 'ERP red', 1, '0', 0, '20.00', '19.00'],
      ['30', 'Deleted stocked', 'ERP stocked', 1, '0', 1, '30.00', '29.00'],
      ['40', 'Deleted family', 'ERP family', 3, '0', 1, '40.00', '39.00'],
      ['41', 'Family S', 'ERP FS', 1, '40', 1, '41.00', '40.00'],
      ['42', 'Family M', 'ERP FM', 1, '40', 0, '42.00', '41.00'],
      ['50', 'Digital item', 'ERP digital', 5, '0', 0, '50.00', '49.00'],
      ['60', '', 'ERP blank', 1, '0', 0, '60.00', '59.00'],
      ['70', 'Orphan variant', 'ERP orphan', 1, '99', 0, '70.00', '69.00'],
      ['80', 'Deleted empty', 'ERP empty', 1, '0', 1, '80.00', '79.00'],
      ['90', 'Unassigned literal %_SKU', 'ERP unassigned', 1, '0', 0, '0.00', '0.00'],
      ['100', 'It\'s "quoted" 50%_off', 'ERP quote', 1, '0', 0, '20.00', '5.50'],
      ['101', 'Untyped blue', 'ERP untyped', 7, '0', 0, '1.10', '1.10'],
      ['102', 'Null price blue', null, 1, '0', 0, '2.00', '2.00'],
      ['9007199254740993', 'Large ID blue', 'ERP large', 1, '0', 0, '99.00', '90.00'],
      ['9007199254740995', 'Large variant', '', 1, '9007199254740993', 0, '1.00', '1.00'],
    ];
    for (const [id, product, erp, type, parent, deleted, price, special] of products)
      await fixture.insert('products', {
        id,
        product,
        erp_product: erp,
        prod_type: type,
        parent_prod_id: parent,
        is_del: deleted,
        price,
        spl_price: special,
        url_key: `url-${id}`,
        add_desc_id: id === '10' ? 1 : 2,
        short_desc: '<p>Fixture short</p>',
        images_new: id === '20' ? 'not json' : '{"male":["one.jpg"],"female":["two.jpg"]}',
      });
    await fixture.insert('add_desc', {
      id: 1,
      name: 'Fixture description',
      desc: '<b>Fixture long</b>',
      material: 'Cotton',
    });
    const stock: [number, string, number, number, number, number][] = [
      [1, '10', 1, 0, 1, 0],
      [2, '10', 2, 0, 0, 1],
      [3, '11', 1, 3, 0, 1],
      [4, '12', 2, 4, 0, 1],
      [5, '13', 1, 0, 0, 1],
      [6, '14', 1, 2, 0, 1],
      [7, '14', 4, 9, 0, 0],
      [8, '20', 1, 0, 0, 1],
      [9, '20', 2, 0, 1, 1],
      [10, '20', 6, 1, 0, 1],
      [11, '21', 2, 7, 0, 1],
      [12, '30', 1, 5, 0, 1],
      [13, '30', 2, 0, 0, 1],
      [14, '40', 1, 0, 0, 1],
      [15, '40', 2, 0, 0, 1],
      [16, '41', 1, 4, 0, 1],
      [17, '42', 2, 0, 0, 1],
      [18, '50', 1, 1, 0, 1],
      [19, '60', 1, 1, 0, 1],
      [20, '70', 1, 1, 0, 1],
      [21, '80', 1, 0, 0, 1],
      [22, '100', 1, -2, 0, 1],
      [23, '100', 2, 6, 0, 1],
      [24, '101', 2, 1, 0, 1],
      [25, '102', 1, 3, 0, 1],
      [26, '102', 3, 3, 0, 1],
      [27, '9007199254740993', 1, 1, 0, 1],
      [28, '9007199254740995', 1, 8, 0, 1],
      [29, '9007199254740995', 2, 0, 1, 1],
    ];
    for (const [id, product, store, value, deleted, available] of stock)
      await fixture.insert('product_store', {
        id,
        product_id: product,
        store_id: store,
        stock: value,
        is_del: deleted,
        is_avail: available,
      });
    const prices: [string, number, number, number | null][] = [
      ['10', 2, 1, 8.25],
      ['10', 2, 2, 8.25],
      ['10', 1, 1, 3],
      ['20', 2, 1, 0],
      ['21', 2, 3, 4.5],
      ['100', 2, 0, 1.75],
      ['102', 2, 1, null],
      ['9007199254740993', 2, 1, 77.5],
    ];
    for (const [product, list, location, price] of prices)
      await fixture.insert('pricelist', {
        product_id: product,
        pricelist_id: list,
        location_id: location,
        price,
      });
    const barcodes: [number, string, string][] = [
      [1, '11', '9007199254740993'],
      [2, '11', '9007199254740994'],
      [3, '12', '9007199254740995'],
      [4, '20', '0'],
      [5, '14', '8901234567890'],
      [6, '9007199254740995', '9007199254740997'],
      [7, '100', '8901234567891'],
    ];
    for (const [id, product, gtin] of barcodes)
      await fixture.insert('products_gs1', { id, product_id: product, gtin });
    for (const [id, category] of [
      [1, 'Cotton'],
      [2, 'Blue'],
      [3, 'Apparel'],
    ] as const)
      await fixture.insert('categories', { id, category });
    for (const [id, product, category] of [
      [1, '10', 1],
      [2, '10', 2],
      [3, '10', 1],
      [4, '20', 2],
      [5, '21', 3],
      [6, '100', 99],
      [7, '9007199254740993', 3],
      [8, '9007199254740993', 1],
    ] as const)
      await fixture.insert('has_categories', { id, prod_id: product, cat_id: category });
    await fixture.insert('users', { id: 1, firstname: 'Customer', lastname: 'Fixture' });
    await fixture.insert('users', { id: 2, firstname: 'Solo', lastname: '' });
    for (const [id, store, name] of [
      [7, 1, 'Legacy storage ID'],
      [9, 1, 'Actual bin'],
      [10, 4, 'Warehouse bin'],
    ] as const)
      await fixture.insert('store_storages', {
        id,
        store_id: store,
        storage_name: name,
        is_active: 1,
      });
    for (const [id, storage, store, product] of [
      [7, 9, 1, '20'],
      [10, 10, 4, '20'],
    ] as const)
      await fixture.insert('stock_storages', {
        id,
        storage_id: storage,
        store_id: store,
        product_id: product,
        stock: 2,
      });
    const logs: [number, number, string, string, string, string, number, number, number][] = [
      [1, 1, '3', '9', '2026-11-16 09:00:00', '20', 1, 1, 7],
      [2, 2, '{"2":7,"1":3}', '{"1":2,"2":30}', '2026-11-16 10:00:00', '20', 0, 1, 7],
      [3, 1, '4', '2', '2026-11-15 09:00:00', '20', 999, 1, 7],
      [4, 1, '2', '2', '2026-11-16 10:00:00', '20', 999, 2, 9],
      [5, 4, '1', '5', '2026-11-16 11:00:00', '20', 2, 0, 10],
      [6, 3, '5', '1', '2026-11-16 12:00:00', '20', 1, 1, 7],
      [7, 2, '-1', '8', '2026-11-16 13:30:00', '20', 3, 2, 404],
      [8, 1, '0', '1', '2026-11-16 23:59:59', '20', 0, 999, 9],
      [9, 1, '6', '7', '2026-11-16 10:00:00', '21', 1, 1, 9],
      [10, 2, '1', '3', '2026-11-16 08:00:00', '20', 0, 2, 7],
    ];
    for (const table of [
      'pos_product_inventory_logs',
      'pos_hold_stock_logs',
      'stock_storage_logs',
    ]) {
      for (const [id, store, before, after, date, product, pos, user, storage] of logs) {
        await fixture.insert(table, {
          id,
          store_id: store,
          product_id: product,
          stock_before: before,
          stock_after: after,
          user_id: user,
          pos_user_id: pos,
          comment: id === 7 ? 'Fixture 50% comment' : 'Fixture comment',
          created_at: date,
          ...(table === 'stock_storage_logs'
            ? { storage_id: storage }
            : table === 'pos_product_inventory_logs'
              ? { type: 1 }
              : {}),
        });
      }
    }
    url.pathname = '/' + schema;
    config.MYSQL_WRITER_URL = url.toString();
    config.MYSQL_PRIMARY_READER_URL = url.toString();
    config.MYSQL_DATA_READER_URL = url.toString();
    config.MYSQL_ALLOW_LOCAL_PLAINTEXT = true;
    databases = createDatabases(config);
  });
  afterAll(async () => {
    await clearCheckIn('1');
    await clearCheckIn('2');
    await databases?.close();
    if (connection) {
      if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });

  const searches = [
    '',
    'blue',
    'Blue S',
    'cafe',
    '%',
    '_',
    '%_',
    '50%',
    "'",
    '"quoted"',
    'url-1',
    '9007',
    'Simple',
    'Configurable',
    "' OR 1=1 --",
  ];

  it('product catalog search: counts, paging, sorts, conflicts and scopes', async () => {
    const current = catalogDetailsService(config, db()),
      raw = rawCatalogDetailsService(config, db());
    const sorts = productSort.options;
    const storeSets = [['1', '2'], ['1'], ['2', '1', '6'], ['4'], ['1', '3'], []];
    for (const storeIds of storeSets)
      for (const sort of sorts)
        for (const direction of ['asc', 'desc'] as const)
          for (const [length, start] of [
            [3, 0],
            [3, 3],
            [2, 5],
            [25, 0],
            [3, 2],
          ] as const) {
            const input = productSearchInput.parse({ storeIds, sort, direction, length, start });
            await same(
              JSON.stringify(input),
              () => current.search(admin, input),
              () => raw.search(admin, input),
            );
          }
    for (const search of searches)
      for (const sort of ['id', 'product', 'categories', 'store_names', 'exclusive_price'] as const)
        for (const start of [0, 2]) {
          const input = productSearchInput.parse({
            storeIds: ['1', '2', '6'],
            search,
            sort,
            direction: 'desc',
            length: 2,
            start,
            draw: 7,
          });
          await same(
            JSON.stringify(input),
            () => current.search(admin, input),
            () => raw.search(admin, input),
          );
        }
    const scoped = productSearchInput.parse({ storeIds: ['1'] });
    await same(
      'franchise',
      () => current.search(franchise, scoped),
      () => raw.search(franchise, scoped),
    );
    const denied = productSearchInput.parse({ storeIds: ['2'] });
    await same(
      'denied',
      () => current.search(franchise, denied),
      () => raw.search(franchise, denied),
    );
  }, 120000);

  it('product detail: family, barcodes, descriptions, prices and visible stock', async () => {
    const current = catalogDetailsService(config, db()),
      raw = rawCatalogDetailsService(config, db());
    for (const id of [
      '10',
      '11',
      '20',
      '21',
      '40',
      '70',
      '100',
      '101',
      '102',
      '9007199254740993',
      '9007199254740995',
      '404',
    ])
      for (const user of [admin, franchise, scopedAdmin])
        await same(
          `detail ${id} ${user.id}`,
          () => current.detail(user, id),
          () => raw.detail(user, id),
        );
  }, 60000);

  it('offline snapshot: barcode, inherited prices, last pricelist row and stock', async () => {
    const current = catalogSnapshotService(db()),
      raw = rawCatalogSnapshotService(db());
    for (const store of ['1', '2', '3', '4', '6', '404'])
      for (const user of [admin, franchise]) {
        const expected = withoutClock(await settle(() => raw.read(user, store))),
          actual = withoutClock(await settle(() => current.read(user, store)));
        expect(actual, `snapshot ${store} ${user.id}`).toEqual(expected);
      }
  }, 60000);

  it('inventory matrix: eligibility, ERP inheritance, literal search, sorts and pages', async () => {
    const current = inventoryMatrixService(db()),
      raw = rawInventoryMatrixService(db());
    for (const user of [admin, scopedAdmin, franchise])
      for (const storeIds of [[], ['1', '2'], ['2'], ['4', '6']])
        for (const search of ['', 'blue', '%', '%_', '_', '\\', 'Large', '9007', 'Orphan'])
          for (const sort of ['id', 'product', 'erp_product'] as const)
            for (const direction of ['asc', 'desc'] as const)
              for (const start of [0, 2]) {
                const input = inventoryMatrixInput.parse({
                  storeIds,
                  search,
                  sort,
                  direction,
                  start,
                  length: 2,
                });
                await same(
                  `${user.id} ${JSON.stringify(input)}`,
                  () => current.search(user, input),
                  () => raw.search(user, input),
                );
              }
  }, 180000);

  it('inventory audit: product, held and storage history on the data reader', async () => {
    const clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
    const current = inventoryAuditService(config, db(), {}, undefined, clock),
      raw = rawInventoryAuditService(config, db(), {}, undefined, clock),
      before = nonEmpty;
    const sorts = [
      'id',
      'store_name',
      'storage_name',
      'product_id',
      'product',
      'erp_product',
      'created_at',
    ] as const;
    for (const kind of ['product', 'held', 'storage'] as AuditKind[])
      for (const product of ['20', '21', '404'])
        for (const storeIds of [['1', '2'], ['1', '3', '4'], ['2'], []])
          for (const search of [
            '',
            'Fixture',
            'Alpha',
            '2026-11-16 1',
            '%',
            'bin',
            'Customer',
            'Solo',
            '"',
            '20',
          ])
            for (const sort of sorts)
              for (const direction of ['asc', 'desc'] as const) {
                if (search && sort !== 'id' && sort !== 'created_at') continue;
                for (const start of [0, 2]) {
                  const input = auditSearchInput.parse({
                    storeIds,
                    from: '2026-11-16T00:00:00',
                    to: '2026-11-16T23:59:59',
                    search,
                    sort,
                    direction,
                    start,
                    length: 2,
                  });
                  await same(
                    `${kind} ${product} ${JSON.stringify(input)}`,
                    () => current.search(admin, product, kind, input),
                    () => raw.search(admin, product, kind, input),
                  );
                }
              }
    expect(nonEmpty - before).toBeGreaterThan(150);
    const sample = await current.search(
      admin,
      '20',
      'product',
      auditSearchInput.parse({
        storeIds: ['1'],
        from: '2026-11-16T00:00:00',
        to: '2026-11-16T23:59:59',
      }),
    );
    expect(sample.reader).toBe('data');
  }, 240000);

  it('counter catalog: search, exact barcode, stock filter and cursor', async () => {
    const current = catalogService(db()),
      raw = rawCatalogService(db());
    for (const store of ['1', '2', '4'])
      for (const search of ['', 'blue', 'Café', '%', '_', '9007', '89012345678', '50%'])
        for (const includeOutOfStock of [false, true])
          for (const after of ['0', '20'])
            await same(
              `${store} ${search} ${includeOutOfStock} ${after}`,
              () => current.products(admin, store, search, after, 3, includeOutOfStock),
              () => raw.products(admin, store, search, after, 3, includeOutOfStock),
            );
    for (const barcode of ['9007199254740994', '9007199254740997', '8901234567890', '0', '1'])
      for (const store of ['1', '2'])
        await same(
          `barcode ${store} ${barcode}`,
          () => current.products(admin, store, '', '0', 2, true, barcode),
          () => raw.products(admin, store, '', '0', 2, true, barcode),
        );
  }, 60000);

  it('reconciliation conflicts surface identically after a conflicting membership price', async () => {
    await native().query(
      'INSERT INTO pricelist(product_id,pricelist_id,location_id,price) VALUES (20,2,2,1),(9007199254740993,2,2,NULL)',
    );
    try {
      const current = catalogDetailsService(config, db()),
        raw = rawCatalogDetailsService(config, db());
      for (const sort of ['id', 'exclusive_price', 'product'] as const)
        for (const search of ['', 'Café', 'Large', 'blue']) {
          const input = productSearchInput.parse({
            storeIds: ['1', '2'],
            sort,
            search,
            length: 25,
          });
          await same(
            JSON.stringify(input),
            () => current.search(admin, input),
            () => raw.search(admin, input),
          );
        }
      for (const id of ['20', '9007199254740993'])
        await same(
          `detail ${id}`,
          () => current.detail(admin, id),
          () => raw.detail(admin, id),
        );
      const snapshotCurrent = withoutClock(
          await settle(() => catalogSnapshotService(db()).read(admin, '1')),
        ),
        snapshotRaw = withoutClock(
          await settle(() => rawCatalogSnapshotService(db()).read(admin, '1')),
        );
      expect(snapshotCurrent).toEqual(snapshotRaw);
    } finally {
      await native().query(
        'DELETE FROM pricelist WHERE pricelist_id=2 AND location_id=2 AND product_id IN (20,9007199254740993)',
      );
    }
    expect(nonEmpty).toBeGreaterThan(100);
  }, 60000);
});
