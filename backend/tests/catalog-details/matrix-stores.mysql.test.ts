import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { ProductStore, Product, Store } from '../../src/db/legacy-schema.js';
import {
  inventoryMatrixInput,
  inventoryMatrixService,
} from '../../src/modules/catalog-details/matrix.js';
import type { Principal } from '../../src/domain/access.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

const integration = process.env.MYSQL_INTEGRATION_URL;
/**
 * The stock-matrix store picker lists exactly what the matrix search authorises: legacy
 * `ProductsStockView.get_queryset` (core/views.py:183-190) shows every active store to role 1 and
 * only the assigned active stores to every other role.
 */
describe.skipIf(!integration)('stock-matrix store picker scope on production DDL', () => {
  let connection: mysql.Connection, db: Databases, schema: string;
  const operator = (role: Principal['role'], storeIds: string[], userType: 1 | 2 = 1) =>
    ({
      id: '9',
      name: 'Synthetic operator',
      email: 'operator@example.test',
      role,
      userType,
      storeIds,
    }) satisfies Principal;
  beforeAll(async () => {
    const url = new URL(integration!);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_integration'
    )
      throw new Error('GUARDED_LOCAL_MATRIX_DATABASE_REQUIRED');
    schema = 'pos_rewrite_matrix_stores_' + randomUUID().replaceAll('-', '').slice(0, 12);
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection);
    await fixture.create([Store, Product, ProductStore].map(getTableName));
    for (const [id, name, active] of [
      [1, 'Bandra', 1],
      [2, 'Andheri', 1],
      [3, 'Colaba', 1],
      [4, 'Closed outlet', 0],
    ] as const)
      await fixture.insert(getTableName(Store), { id, store_name: name, is_active: active });
    url.pathname = '/' + schema;
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'matrix-store-picker-fixture-'.repeat(3),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
      }),
    );
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
      await connection.end();
    }
  });
  it('lists only assigned active stores for role 4, and every listed store is searchable', async () => {
    const matrix = inventoryMatrixService(db),
      user = operator(4, ['1', '3', '4']);
    const listed = await matrix.stores(user);
    expect(listed.data).toEqual([
      { id: '1', name: 'Bandra' },
      { id: '3', name: 'Colaba' },
    ]);
    for (const store of listed.data)
      await expect(
        matrix.search(user, inventoryMatrixInput.parse({ storeIds: [store.id] })),
      ).resolves.toMatchObject({ stores: [store] });
    await expect(
      matrix.search(user, inventoryMatrixInput.parse({ storeIds: ['2'] })),
    ).rejects.toMatchObject({ status: 403, code: 'STORE_ACCESS_DENIED' });
  });
  it('lists every active store for role 1 and nothing for an unassigned operator', async () => {
    const matrix = inventoryMatrixService(db);
    expect((await matrix.stores(operator(1, []))).data.map((store) => store.id)).toEqual([
      '2',
      '1',
      '3',
    ]);
    expect((await matrix.stores(operator(4, []))).data).toEqual([]);
  });
  it('refuses franchise operators exactly as the search does', async () => {
    await expect(inventoryMatrixService(db).stores(operator(1, ['1'], 2))).rejects.toMatchObject({
      status: 403,
      code: 'INVENTORY_ADMINISTRATION_DENIED',
    });
  });
});
