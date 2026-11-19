import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
export async function orderSearchFixture(template: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_order_search_test'
  )
    throw new Error('Use the explicit isolated order-search localhost template.');
  const schema = `pos_rewrite_order_search_${process.pid}_${randomUUID().slice(0, 8)}`;
  const connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  let db: ReturnType<typeof createDatabases> | undefined;
  try {
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection, [
      'evidence/mysql-order-list-collations-schema.json',
    ]);
    await fixture.create([
      'pos_user',
      'user_stores',
      'orders',
      'users',
      'order_stores',
      'order_status',
      'payment_status',
      'payment_method',
      'has_products',
      'stores',
      'store_counters',
      'hyperlocal_locations',
      'hyperlocal_order_log',
      'express_line_item',
      'pos_terminal_transactions',
      'pos_paytm_transactions',
    ]);
    await connection.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_AUTO_VALUE_ON_ZERO'");
    url.pathname = '/' + schema;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'synthetic-order-list-secret-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_DATA_READER_URL: url.href,
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    db = createDatabases(config);
    const databases = db;
    return {
      connection,
      fixture,
      config,
      db: databases,
      url: url.href,
      async close() {
        await databases.close();
        await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
        await connection.end();
      },
    };
  } catch (error) {
    await db?.close();
    await connection
      .query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`)
      .catch(() => undefined);
    await connection.end();
    throw error;
  }
}
