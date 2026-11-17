import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
export async function wholeStatusFixture(template: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_whole_status_test'
  )
    throw new Error('Use the explicit isolated whole-order status localhost template.');
  const schema = `pos_rewrite_whole_status_${process.pid}_${randomUUID().slice(0, 8)}`;
  const connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  let db: ReturnType<typeof createDatabases> | undefined;
  try {
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection);
    await fixture.create([
      'pos_user',
      'user_stores',
      'stores',
      'store_counters',
      'orders',
      'order_stores',
      'order_status',
      'has_products',
      'products',
      'express_line_item',
      'vinculum_auto_delivered_logs',
    ]);
    for (const path of [
      'migrations/0006_operator_auth_epochs.sql',
      'src/modules/administration/migration.sql',
      'src/modules/checkout/migrations/0004_returns.sql',
      'src/modules/legacy-order-status/migration.sql',
      'src/modules/legacy-order-status/repair-migration.sql',
    ])
      for (const statement of readFileSync(path, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
    url.pathname = '/' + schema;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'synthetic-status-session-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_DATA_READER_URL: url.href,
    });
    db = createDatabases(config);
    const databases = db;
    return {
      connection,
      fixture,
      config,
      db: databases,
      url: url.href,
      async reset() {
        const [rows] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES');
        for (const row of rows)
          await connection.query('DELETE FROM ' + mysql.escapeId(String(Object.values(row)[0])));
      },
      async close() {
        await databases.close();
        await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
        await connection.end();
      },
    };
  } catch (error: unknown) {
    await db?.close();
    await connection
      .query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`)
      .catch(() => undefined);
    await connection.end();
    throw error;
  }
}
