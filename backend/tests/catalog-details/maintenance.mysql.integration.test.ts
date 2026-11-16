import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { catalogMaintenanceOptions } from '../../src/modules/catalog-details/maintenance-options.js';
import { catalogMaintenanceService } from '../../src/modules/catalog-details/maintenance-service.js';
import type { MaintenancePayload } from '../../src/modules/catalog-details/maintenance-domain.js';
import {
  MaintenanceDeliveryError,
  type MaintenanceDeliveryContext,
  type MaintenanceTransports,
} from '../../src/modules/catalog-details/maintenance-transports.js';
const integration = process.env.MYSQL_INTEGRATION_URL;
const user: Principal = {
  id: '1',
  name: 'Fixture operator',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: [],
};
describe.skipIf(!integration)('durable catalog maintenance on isolated verified MySQL', () => {
  const schema =
      'pos_rewrite_catalog_maintenance_test_' + randomUUID().replaceAll('-', '').slice(0, 12),
    config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'catalog-maintenance-native-'.repeat(3),
    }),
    options = catalogMaintenanceOptions({});
  let connection: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false,
    now = Temporal.Instant.from('2026-11-16T06:00:00Z');
  const sent: Array<{ payload: MaintenancePayload; context: MaintenanceDeliveryContext }> = [];
  const transport: MaintenanceTransports = {
    inventory: {
      identity: 'a'.repeat(64),
      send: async (payload, context) => {
        sent.push({ payload, context });
      },
    },
    products: {
      identity: 'b'.repeat(64),
      send: async (payload, context) => {
        sent.push({ payload, context });
      },
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
      catalogMaintenanceService(db(), options, selected, () => now);
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
    for (const statement of readFileSync(
      'src/modules/catalog-details/maintenance-migration.sql',
      'utf8',
    )
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean))
      await connection.query(statement);
    url.pathname = '/' + schema;
    config.MYSQL_WRITER_URL = url.toString();
    config.MYSQL_PRIMARY_READER_URL = url.toString();
    config.MYSQL_ALLOW_LOCAL_PLAINTEXT = true;
    databases = createDatabases(config);
  });
  beforeEach(async () => {
    sent.length = 0;
    now = Temporal.Instant.from('2026-11-16T06:00:00Z');
    for (const table of [
      'pos_rewrite_catalog_reconciliations',
      'pos_rewrite_catalog_deliveries',
      'pos_rewrite_catalog_commands',
      'pos_rewrite_catalog_locks',
      'products_gs1',
      'product_store',
      'products',
      'pos_user',
    ])
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
  it('preserves manual/CSV simple-SKU selection, immutable commands and scoped transport identity', async () => {
    const api = service(),
      id = randomUUID(),
      input = { mode: 'manual' as const, skus: '11,10,11,999' };
    const first = await api.enqueuePull(user, id, input, 'fixture-pull');
    expect(first.metadata).toMatchObject({
      requestedCount: 4,
      uniqueRequestedCount: 3,
      matchedCount: 1,
      mode: 'manual',
    });
    expect(first.deliveries[0]?.productIds).toEqual(['11']);
    expect(await api.enqueuePull(user, id, input, 'fixture-replay')).toEqual(first);
    await expect(
      api.enqueuePull(user, id, { mode: 'manual', skus: '20' }, 'fixture-conflict'),
    ).rejects.toMatchObject({ status: 409 });
    expect(sent).toHaveLength(0);
    expect(await api.runOne()).toMatchObject({
      state: 'SUCCEEDED',
      userId: '1',
      requestId: 'fixture-pull',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toEqual({
      kind: 'inventory-pull',
      mode: 'manual',
      productIds: ['11'],
    });
    await api.enqueuePull(
      user,
      randomUUID(),
      { mode: 'csv', filename: 'fixture.csv', csv: 'sku\n20\n10\n11\n11\n' },
      'fixture-csv',
    );
    await api.runOne();
    expect(sent[1]?.payload).toEqual({
      kind: 'inventory-pull',
      mode: 'csv',
      productIds: ['11', '20'],
    });
  });
  it('matches the actual source repair effects while preserving quantities and syncing every changed SKU', async () => {
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
          execFileSync('python3', ['tools/catalog-details/maintenance-oracle.py'], {
            input: JSON.stringify({
              kind: 'product-troubleshoot',
              productId: '11',
              products,
              stock,
              barcodes,
            }),
            encoding: 'utf8',
            timeout: 10000,
          }),
        ) as unknown,
      );
    const api = service(),
      plan = await api.preview(user, '11'),
      id = randomUUID();
    expect(plan).toMatchObject({
      parentVisibility: [{ id: '1', storeId: '1' }],
      imageReset: true,
      imageProductId: '10',
      barcodeChanges: [{ id: '2', productId: '20', from: '77', to: '770123' }],
      syncProductIds: ['11', '20'],
    });
    const receipt = await api.troubleshoot(user, id, '11', plan.planHash, 'fixture-repair');
    expect(receipt).toMatchObject({
      localApplied: true,
      state: 'PENDING',
      metadata: { parentRowsChanged: 1, imageReset: true, barcodeRowsChanged: 1 },
    });
    expect(await snapshot()).toEqual({
      products: expected.products,
      stock: expected.stock,
      barcodes: expected.barcodes,
    });
    expect(await api.troubleshoot(user, id, '11', plan.planHash, 'fixture-replay')).toEqual(
      receipt,
    );
    await api.runOne();
    await api.runOne();
    expect(sent[0]?.payload).toEqual({
      kind: 'product-sync',
      productIds: ['11'],
      troubleshoot: true,
    });
    expect(expected.calls).toEqual([{ ids: ['11'], troubleshoot: true }]);
    expect(sent[1]?.payload).toEqual({
      kind: 'product-sync',
      productIds: ['20'],
      troubleshoot: false,
    });
    expect((await api.get(user, id)).state).toBe('SUCCEEDED');
  });
  it('rolls back every local repair when its durable outbox cannot be persisted', async () => {
    const api = service(),
      before = await snapshot(),
      plan = await api.preview(user, '11');
    await native().query(
      "CREATE TRIGGER fixture_reject_catalog_delivery BEFORE INSERT ON pos_rewrite_catalog_deliveries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Fixture delivery rejection'",
    );
    try {
      await expect(
        api.troubleshoot(user, randomUUID(), '11', plan.planHash, 'fixture-rollback'),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      const [rows] = await native().query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) as count FROM pos_rewrite_catalog_commands',
      );
      expect(Number(rows[0]?.count)).toBe(0);
    } finally {
      await native().query('DROP TRIGGER fixture_reject_catalog_delivery');
    }
  });
  it('rejects stale previews, suffix overflow and collisions before changing source rows', async () => {
    const api = service(),
      plan = await api.preview(user, '11');
    await native().query("UPDATE products SET images_new='newer-image' WHERE id=10");
    const before = await snapshot();
    await expect(
      api.troubleshoot(user, randomUUID(), '11', plan.planHash, 'fixture-stale'),
    ).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
    await native().query(
      'UPDATE products_gs1 SET gtin=9223372036854775807 WHERE product_id IN(11,20)',
    );
    await expect(api.preview(user, '11')).rejects.toMatchObject({
      code: 'CATALOG_BARCODE_RECONCILIATION_REQUIRED',
    });
    await native().query('UPDATE products_gs1 SET gtin=77 WHERE product_id IN(11,20)');
    await native().query('UPDATE products_gs1 SET gtin=770123 WHERE product_id=30');
    await expect(api.preview(user, '11')).rejects.toMatchObject({
      code: 'CATALOG_BARCODE_RECONCILIATION_REQUIRED',
    });
  });
  it('records uncertain outcomes without a blind retry and keeps reconciliation immutable', async () => {
    let fail = true;
    const outgoing: MaintenanceTransports = {
        inventory: {
          identity: 'a'.repeat(64),
          send: async (payload, context) => {
            sent.push({ payload, context });
            if (fail) throw new Error('fixture@example.test secret failure');
          },
        },
      },
      api = service(outgoing),
      id = randomUUID();
    await api.enqueuePull(user, id, { mode: 'manual', skus: '11' }, 'fixture-uncertain');
    expect(await api.runOne()).toMatchObject({
      state: 'UNCERTAIN',
      errorCode: 'CATALOG_DELIVERY_OUTCOME_UNKNOWN',
    });
    expect(await api.runOne()).toBeNull();
    expect(sent).toHaveLength(1);
    const receipt = await api.get(user, id),
      delivery = receipt.deliveries[0]!,
      reconciliation = randomUUID();
    await api.reconcile(
      user,
      id,
      delivery.id,
      reconciliation,
      'not-delivered',
      'fixture-reconcile',
    );
    await api.reconcile(user, id, delivery.id, reconciliation, 'not-delivered', 'fixture-repeat');
    await expect(
      api.reconcile(user, id, delivery.id, reconciliation, 'delivered', 'fixture-conflict'),
    ).rejects.toMatchObject({ status: 409 });
    fail = false;
    await api.runOne();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.context.deliveryId).toBe(sent[0]?.context.deliveryId);
    expect((await api.get(user, id)).state).toBe('SUCCEEDED');
  });
  it('denies revoked global authority, but completes derivative sync for an already committed repair', async () => {
    const api = service(),
      pull = randomUUID();
    await api.enqueuePull(user, pull, { mode: 'manual', skus: '11' }, 'fixture-revoked');
    await native().query('UPDATE pos_user SET role=2 WHERE id=1');
    expect(await api.runOne()).toMatchObject({
      state: 'FAILED',
      errorCode: 'CATALOG_OPERATOR_REVOKED',
    });
    expect(sent).toHaveLength(0);
    await expect(api.get(user, pull)).rejects.toMatchObject({ status: 403 });
    await native().query('UPDATE pos_user SET role=1 WHERE id=1');
    const plan = await api.preview(user, '11'),
      repair = randomUUID();
    await api.troubleshoot(user, repair, '11', plan.planHash, 'fixture-committed');
    await native().query('UPDATE pos_user SET is_active=0 WHERE id=1');
    await api.runOne();
    await api.runOne();
    expect((await api.get({ ...user, id: '3' }, repair)).state).toBe('SUCCEEDED');
  });
  it('expires a reservation and refuses a late callback from an older reconciled attempt', async () => {
    let release: ((value: void) => void) | undefined,
      attempts = 0;
    const outgoing: MaintenanceTransports = {
        inventory: {
          identity: 'a'.repeat(64),
          send: async () => {
            attempts++;
            if (attempts === 1) {
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              throw new MaintenanceDeliveryError('uncertain', 'INVENTORY_PULL_OUTCOME_UNKNOWN');
            }
          },
        },
      },
      api = service(outgoing),
      id = randomUUID();
    await api.enqueuePull(user, id, { mode: 'manual', skus: '11' }, 'fixture-lease');
    const first = api.runOne();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    now = now.add({ seconds: 121 });
    expect(await api.runOne()).toMatchObject({ state: 'UNCERTAIN' });
    const receipt = await api.get(user, id);
    await api.reconcile(
      user,
      id,
      receipt.deliveries[0]!.id,
      randomUUID(),
      'not-delivered',
      'fixture-confirm',
    );
    expect(await api.runOne()).toMatchObject({ state: 'SUCCEEDED' });
    release?.();
    await first;
    expect((await api.get(user, id)).state).toBe('SUCCEEDED');
    expect(attempts).toBe(2);
  });
});
