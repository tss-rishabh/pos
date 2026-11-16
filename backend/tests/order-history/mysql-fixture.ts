import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
export async function orderHistoryFixture(template: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_order_history_test'
  )
    throw new Error(
      'Order history tests require their explicit isolated localhost database template.',
    );
  const schema = `pos_rewrite_order_history_${process.pid}_${randomUUID().slice(0, 8)}`;
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
      'orders',
      'order_stores',
      'order_status',
      'payment_status',
      'has_products',
      'products',
    ]);
    for (const statement of readFileSync('migrations/0006_operator_auth_epochs.sql', 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .filter((s) => s.trim()))
      await connection.query(statement);
    url.pathname = '/' + schema;
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'synthetic-order-history-native-secret-'.repeat(2),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      }),
      databases = createDatabases(config);
    db = databases;
    return {
      connection,
      fixture,
      config,
      db: databases,
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
  } catch (error) {
    await db?.close();
    await connection
      .query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`)
      .catch(() => undefined);
    await connection.end();
    throw error;
  }
}
