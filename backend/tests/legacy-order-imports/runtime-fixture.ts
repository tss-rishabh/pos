import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTableName } from 'drizzle-orm';
import mysql from 'mysql2/promise';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { splitMigration } from '../../src/db/migrations.js';
import { PosUser, Store, StoreCounter, UserStore } from '../../src/db/legacy-schema.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { offlineOrderColumns } from '../../src/modules/legacy-order-imports/csv.js';

export const runtimeImportSecret = 'isolated-order-import-runtime-proof-'.repeat(3);
export function runtimeImportInput(id = randomUUID()) {
  const values: Record<(typeof offlineOrderColumns)[number], string> = {
    SerialNo: 'fixture-reference',
    StoreId: '1',
    Email: 'private-import@example.test',
    UserName: 'Private fixture name',
    IsExclusive: '1',
    ProductId: '9007199254740993',
    ProductQty: '2',
    ProductPrice: '25.49',
    PaymentMode: 'cash',
    OrderDate: '2026-06-15 12:00:00',
    OrderPlacedSms: '0',
    OrderMessage: 'Private fixture message',
  };
  return {
    id,
    kind: 'offline' as const,
    counters: [{ storeId: '1', counterId: '2' }],
    csv:
      offlineOrderColumns.join(',') +
      '\n' +
      offlineOrderColumns.map((column) => values[column]).join(','),
  };
}
export async function orderImportRuntimeFixture(template: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_legacy_order_imports_test' ||
    url.search ||
    url.hash
  )
    throw new Error('Explicit isolated localhost order-import fixture required.');
  const schema = 'pos_rewrite_import_runtime_' + randomUUID().replaceAll('-', '').slice(0, 12),
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
  try {
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection),
      tables = [PosUser, Store, StoreCounter, UserStore].map(getTableName);
    await fixture.create(tables);
    for (const statement of splitMigration(
      readFileSync('src/modules/legacy-order-imports/migration.sql', 'utf8'),
    ))
      await connection.query(statement);
    url.pathname = '/' + schema;
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: runtimeImportSecret,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
      }),
      db = createDatabases(config);
    return {
      config,
      db,
      connection,
      fixture,
      async reset() {
        for (const table of [
          'pos_rewrite_legacy_order_import_rows',
          'pos_rewrite_legacy_order_imports',
          ...tables,
        ])
          await connection.query('DELETE FROM ' + mysql.escapeId(table));
        await fixture.insert(getTableName(PosUser), {
          id: '1',
          username: 'fixture-admin',
          [PosUser.role.name]: 1,
          [PosUser.user_type.name]: 1,
          [PosUser.is_active.name]: 1,
        });
        await fixture.insert(getTableName(Store), {
          id: '1',
          [Store.type.name]: 'STORE',
          [Store.is_active.name]: 1,
        });
        await fixture.insert(getTableName(StoreCounter), {
          id: '2',
          [StoreCounter.store.name]: '1',
          [StoreCounter.is_active.name]: 1,
        });
      },
      async close() {
        await db.close();
        await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
        await connection.end();
      },
    };
  } catch (error) {
    await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
    await connection.end();
    throw error;
  }
}
