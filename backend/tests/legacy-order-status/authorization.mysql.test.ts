import { randomUUID } from 'node:crypto';
import mysql, { type Connection } from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { HasProduct, OrderStore, PosUser, Store, UserStore } from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import { wholeOrderStatusService } from '../../src/modules/legacy-order-status/service.js';
import { queuedMessage } from '../../src/modules/legacy-order-status/domain.js';
import { legacyFixtureRecord } from '../../tools/administration/mysql-fixture.js';
import { createProductionTables } from '../helpers/production-schema.js';
import { options } from './fixtures.js';

/**
 * The sync-repo push (`AjaxUpdateStatusVincView`) is authorized on the writer pool. The reader
 * schema here plays a lagging replica that disagrees with the writer; the outcome must follow the
 * writer every time. Loopback MySQL only; the status API is a recording stub.
 */
const template = process.env.WHOLE_ORDER_STATUS_MYSQL_TEST_URL;
const tables: MySqlTable[] = [HasProduct, OrderStore, PosUser, Store, UserStore];

describe.skipIf(!template)('whole-order status push authorization on the writer', () => {
  let writer: Connection, reader: Connection, db: Databases;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
    writerSchema = `pos_e_status_writer_${suffix}`,
    readerSchema = `pos_e_status_reader_${suffix}`,
    pushes: { orderId: string; ids: string[] }[] = [];
  const url = (schema: string) => {
    const value = new URL(template!);
    value.pathname = '/' + schema;
    return value.href;
  };
  async function seed(
    connection: Connection,
    table: MySqlTable,
    values: Record<string, string | number | boolean | null>,
  ) {
    const record = Object.entries(legacyFixtureRecord(table, values));
    await connection.execute(
      `INSERT INTO ${mysql.escapeId(getTableConfig(table).name)} (${record.map(([name]) => mysql.escapeId(name)).join(',')}) VALUES (${record.map(() => '?').join(',')})`,
      record.map(([, value]) => value),
    );
  }
  /** The same base rows on both pools: operator 2 (role 3) assigned to store 1, order 9 there. */
  async function base(connection: Connection) {
    for (const table of tables)
      await connection.query('DELETE FROM ' + mysql.escapeId(getTableConfig(table).name));
    await seed(connection, Store, { id: 1, store_name: 'Store 1', is_active: 1, type: 'STORE' });
    await seed(connection, Store, { id: 2, store_name: 'Store 2', is_active: 0, type: 'STORE' });
    for (const [id, role] of [
      [1, 1],
      [2, 3],
    ] as const)
      await seed(connection, PosUser, {
        id,
        username: `user${id}`,
        role,
        user_type: 1,
        is_active: 1,
      });
    await seed(connection, UserStore, { django_user_id: 2, store_id: 1 });
    await seed(connection, OrderStore, { order_id: 9, store_id: 1, order_invoice: null });
    await seed(connection, OrderStore, { order_id: 10, store_id: 2, order_invoice: null });
    for (const id of [901, 902]) await seed(connection, HasProduct, { id, order_id: 9 });
  }
  const manager: Principal = {
    id: '2',
    name: 'Manager',
    email: '',
    role: 3,
    userType: 1,
    storeIds: ['1'],
  };
  const admin: Principal = { ...manager, id: '1', role: 1, storeIds: [] };
  const service = () =>
    wholeOrderStatusService(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'synthetic-status-session-key-'.repeat(2),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_PRIMARY_READER_URL: url(readerSchema),
        MYSQL_WRITER_URL: url(writerSchema),
        MYSQL_DATA_READER_URL: url(readerSchema),
      }),
      db,
      options,
      {
        callStatusApi: async (orderId, ids) => {
          pushes.push({ orderId, ids: [...ids] });
          return 'sent';
        },
      },
    );

  beforeAll(async () => {
    const root = new URL(template!);
    if (!['localhost', '127.0.0.1'].includes(root.hostname))
      throw new Error('Whole-order status tests require a loopback MySQL.');
    const connect = async (schema: string) => {
      const connection = await mysql.createConnection({
        host: root.hostname,
        port: Number(root.port || 3306),
        user: decodeURIComponent(root.username),
        password: decodeURIComponent(root.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
      await connection.changeUser({ database: schema });
      await createProductionTables(connection, tables);
      return connection;
    };
    writer = await connect(writerSchema);
    reader = await connect(readerSchema);
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'synthetic-status-session-key-'.repeat(2),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_PRIMARY_READER_URL: url(readerSchema),
        MYSQL_WRITER_URL: url(writerSchema),
        MYSQL_DATA_READER_URL: url(readerSchema),
      }),
    );
  });
  afterAll(async () => {
    await db?.close();
    for (const [connection, schema] of [
      [writer, writerSchema],
      [reader, readerSchema],
    ] as const)
      if (connection) {
        await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
        await connection.end();
      }
  });
  beforeEach(async () => {
    pushes.length = 0;
    await base(writer);
    await base(reader);
  });

  it('pushes when the writer has the assignment and the lagging reader does not', async () => {
    await reader.query('DELETE FROM user_stores');
    await reader.query('UPDATE pos_user SET is_active=0');
    await expect(service().push(manager, '1', '9', 'PACK')).resolves.toEqual({
      message: queuedMessage,
      outcome: 'sent',
    });
    expect(pushes).toEqual([{ orderId: '9', ids: ['901', '902'] }]);
  });

  it('refuses an operator the writer has deactivated, whatever the reader says', async () => {
    await writer.query('UPDATE pos_user SET is_active=0 WHERE id=2');
    await expect(service().push(manager, '1', '9', 'PACK')).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_REQUIRED',
    });
    expect(pushes).toEqual([]);
  });

  it('refuses a store the writer has unassigned, whatever the reader says', async () => {
    await writer.query('DELETE FROM user_stores');
    await expect(service().push(manager, '1', '9', 'SHIP')).rejects.toMatchObject({
      status: 403,
      code: 'STORE_ACCESS_DENIED',
    });
    expect(pushes).toEqual([]);
  });

  it('keeps the legacy order-store scope: another store, or an inactive store for role 1', async () => {
    await expect(service().push(manager, '1', '10', 'PACK')).rejects.toMatchObject({
      status: 404,
      code: 'ORDER_NOT_FOUND',
    });
    await expect(service().push(admin, '2', '10', 'PACK')).rejects.toMatchObject({
      status: 404,
      code: 'ORDER_NOT_FOUND',
    });
    await expect(service().push(admin, '1', '9', 'PACK')).resolves.toMatchObject({
      outcome: 'sent',
    });
    expect(pushes).toEqual([{ orderId: '9', ids: ['901', '902'] }]);
  });
});
