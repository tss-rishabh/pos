import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  catalogMaintenanceService,
  troubleshootMessage,
} from '../../src/modules/catalog-details/maintenance-service.js';
import type { MaintenanceTransports } from '../../src/modules/catalog-details/maintenance-transports.js';
import { goldenStdout } from '../golden/load.js';
const integration = process.env.MYSQL_INTEGRATION_URL;
const user: Principal = {
  id: '3',
  name: 'Fixture cashier',
  email: 'fixture@example.test',
  role: 4,
  userType: 2,
  storeIds: ['1'],
};
describe.skipIf(!integration)('synchronous catalog maintenance on isolated verified MySQL', () => {
  const schema =
      'pos_rewrite_catalog_maintenance_test_' + randomUUID().replaceAll('-', '').slice(0, 12),
    config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'catalog-maintenance-native-'.repeat(3),
    });
  let connection: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false,
    ephemeral = memoryEphemeralStore(),
    failSync = false;
  const sent: Array<{ ids: string[]; mode?: string; troubleshoot?: boolean }> = [],
    logs: string[] = [];
  const transport: MaintenanceTransports = {
    inventory: async (ids, mode) => {
      sent.push({ ids, mode });
      return 200;
    },
    products: async (ids, context) => {
      sent.push({ ids, troubleshoot: context.troubleshoot });
      if (failSync) throw new Error('sync unavailable');
    },
  };
  const native = () => {
      if (!connection) throw new Error('Maintenance fixture unavailable.');
      return connection;
    },
    db = () => {
      if (!databases) throw new Error('Maintenance fixture unavailable.');
      return databases;
    },
    service = (selected = transport) =>
      catalogMaintenanceService(db(), selected, ephemeral, (_level, event) =>
        logs.push(String(event.eventId)),
      );
  beforeAll(async () => {
    const url = new URL(integration!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Catalog maintenance fixtures require localhost.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await connection.changeUser({ database: schema });
    await verifiedMysqlFixture(connection).create([
      'products',
      'product_store',
      'products_gs1',
      'pos_user',
    ]);
    url.pathname = '/' + schema;
    config.MYSQL_WRITER_URL = url.toString();
    config.MYSQL_PRIMARY_READER_URL = url.toString();
    config.MYSQL_ALLOW_LOCAL_PLAINTEXT = true;
    databases = createDatabases(config);
  });
  beforeEach(async () => {
    sent.length = 0;
    logs.length = 0;
    failSync = false;
    ephemeral = memoryEphemeralStore();
    for (const table of ['products_gs1', 'product_store', 'products', 'pos_user'])
      await native().query(`DELETE FROM ${mysql.escapeId(table)}`);
    const fixture = verifiedMysqlFixture(native());
    for (const id of [1, 3])
      await fixture.insert('pos_user', {
        id,
        first_name: 'Fixture',
        last_name: 'Operator',
        role: 1,
        user_type: 1,
        is_active: 1,
      });
    for (const [id, type, parent, images] of [
      [10, 3, 0, ''],
      [11, 1, 10, 'own-image'],
      [20, 1, 0, 'other-image'],
      [30, 1, 0, 'other-image'],
    ] as const)
      await fixture.insert('products', {
        id,
        product: 'Fixture ' + id,
        prod_type: type,
        parent_prod_id: parent,
        images_new: images,
      });
    await fixture.insert('product_store', {
      id: 1,
      product_id: 10,
      store_id: 1,
      stock: 19,
      is_avail: 0,
      is_del: 1,
    });
    await fixture.insert('product_store', {
      id: 2,
      product_id: 10,
      store_id: 2,
      stock: 7,
      is_avail: 1,
      is_del: 0,
    });
    await fixture.insert('product_store', {
      id: 3,
      product_id: 11,
      store_id: 1,
      stock: 5,
      is_avail: 1,
      is_del: 0,
    });
    await fixture.insert('products_gs1', { id: '9007199254740993', product_id: 11, gtin: 77 });
    await fixture.insert('products_gs1', { id: 2, product_id: 20, gtin: 77 });
    await fixture.insert('products_gs1', { id: 3, product_id: 30, gtin: 88 });
  });
  afterAll(async () => {
    await databases?.close();
    if (connection) {
      if (created) await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  async function snapshot() {
    const [products] = await native().query<mysql.RowDataPacket[]>(
        'SELECT id,images_new FROM products ORDER BY id',
      ),
      [stock] = await native().query<mysql.RowDataPacket[]>(
        'SELECT id,stock,is_avail,is_del FROM product_store ORDER BY id',
      ),
      [barcodes] = await native().query<mysql.RowDataPacket[]>(
        'SELECT id,gtin FROM products_gs1 ORDER BY id',
      );
    return {
      products: products.map((row) => ({
        id: String(row.id),
        images_new: row.images_new as unknown,
      })),
      stock: stock.map((row) => ({
        id: String(row.id),
        stock: Number(row.stock),
        is_avail: Number(row.is_avail),
        is_del: Number(row.is_del),
      })),
      barcodes: barcodes.map((row) => ({ id: String(row.id), gtin: String(row.gtin) })),
    };
  }
  async function snapshot() {
    const [products] = await native().query<mysql.RowDataPacket[]>(
        'SELECT id,images_new FROM products ORDER BY id',
      ),
      [stock] = await native().query<mysql.RowDataPacket[]>(
        'SELECT id,stock,is_avail,is_del FROM product_store ORDER BY id',
      ),
      [barcodes] = await native().query<mysql.RowDataPacket[]>(
        'SELECT id,gtin FROM products_gs1 ORDER BY id',
      );
    return {
      products: products.map((row) => ({
        id: String(row.id),
        images_new: row.images_new as unknown,
      })),
      stock: stock.map((row) => ({
        id: String(row.id),
        stock: Number(row.stock),
        is_avail: Number(row.is_avail),
        is_del: Number(row.is_del),
      })),
      barcodes: barcodes.map((row) => ({ id: String(row.id), gtin: String(row.gtin) })),
    };
  }
  it('registers simple SKUs with the legacy manual and CSV payload modes and messages', async () => {
    const api = service();
    expect(await api.inventoryPull(user, { mode: 'manual', skus: '30, 10,11,999,' }, 'r1')).toEqual(
      {
        status: 'success',
        message: 'Sku(s) registered successfully. Please check inventory after sometime.',
        productIds: ['11', '30'],
      },
    );
    expect(
      await api.inventoryPull(
        user,
        { mode: 'csv', filename: 'skus.csv', csv: 'sku\n20\n10\n20\n' },
        'r2',
      ),
    ).toEqual({
      status: 'success',
      message: 'All SKUs processed successfully.Data may take some time to reflect.',
      productIds: ['20'],
    });
    expect(sent).toEqual([
      { ids: ['11', '30'], mode: 'manual' },
      { ids: ['20'], mode: 'csv' },
    ]);
    await expect(
      api.inventoryPull(user, { mode: 'manual', skus: '10,999' }, 'r3'),
    ).rejects.toMatchObject({ status: 422, message: 'No Sku(s) found for inventory pull.' });
    await expect(
      service({}).inventoryPull(user, { mode: 'manual', skus: '11' }, 'r4'),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('matches the actual source repair effects, then syncs only the product (constant 200 message)', async () => {
    const [products] = await native().query<mysql.RowDataPacket[]>(
        'SELECT * FROM products ORDER BY id',
      ),
      [stock] = await native().query<mysql.RowDataPacket[]>(
        'SELECT * FROM product_store ORDER BY id',
      ),
      [barcodes] = await native().query<mysql.RowDataPacket[]>(
        'SELECT * FROM products_gs1 ORDER BY id',
      );
    const expected = z
      .object({
        products: z.array(z.record(z.string(), z.unknown())),
        stock: z.array(z.record(z.string(), z.unknown())),
        barcodes: z.array(z.record(z.string(), z.unknown())),
        calls: z.array(z.unknown()),
      })
      .parse(
        JSON.parse(
          goldenStdout(
            'catalog-details',
            'maintenance-mysql-integration',
            JSON.stringify({
              kind: 'product-troubleshoot',
              productId: '11',
              products,
              stock,
              barcodes,
            }),
          ),
        ) as unknown,
      );
    expect(await service().troubleshoot(user, '11', 'fixture-repair')).toEqual({
      status: 200,
      message: troubleshootMessage,
    });
    expect(await snapshot()).toEqual({
      products: expected.products,
      stock: expected.stock,
      barcodes: expected.barcodes,
    });
    expect(sent).toEqual([{ ids: ['11'], troubleshoot: true }]);
    expect(expected.calls).toEqual([{ ids: ['11'], troubleshoot: true }]);
    expect(await ephemeral.get('pos:lock:catalog:barcode-mutations')).toBeNull();
  });
  it('keeps the committed repair and the constant message when sync or the lock fails', async () => {
    failSync = true;
    expect((await service().troubleshoot(user, '11', 'r1')).message).toBe(troubleshootMessage);
    expect((await snapshot()).barcodes).toContainEqual({ id: '2', gtin: '770123' });
    expect(logs).toEqual(['catalog-details.product-troubleshoot.failed']);
    await native().query('UPDATE products_gs1 SET gtin=77 WHERE id=2');
    await ephemeral.set('pos:lock:catalog:barcode-mutations', 'other-holder', { PX: 60000 });
    const before = await snapshot();
    expect((await service().troubleshoot(user, '11', 'r2')).message).toBe(troubleshootMessage);
    expect(await snapshot()).toEqual(before);
    expect(sent).toEqual([{ ids: ['11'], troubleshoot: true }]);
  }, 15000);
});
