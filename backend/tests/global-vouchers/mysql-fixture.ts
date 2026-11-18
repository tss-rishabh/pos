import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

export async function globalVoucherFixture(template: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_global_vouchers_test' ||
    url.search ||
    url.hash
  )
    throw new Error('Voucher fixtures require an isolated local schema template.');
  const schema = `pos_rewrite_global_vouchers_test_${process.pid}_${randomUUID().slice(0, 8)}`;
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
    const fixture = verifiedMysqlFixture(connection, [
      'evidence/mysql-global-benefits-schema.json',
      'evidence/mysql-gift-card-batches-schema.json',
    ]);
    await fixture.create([
      'users',
      'pos_user',
      'stores',
      'store_counters',
      'user_stores',
      'coupons',
      'gift_vouchers',
      'gift_voucher_history',
      'tss_money_history',
      'reward_point_history',
      'pos_special_permission_activity_log',
      'gift_card_collection',
    ]);
    await connection.query(
      'ALTER TABLE gift_vouchers ADD UNIQUE KEY fixture_verified_code(voucher_code)',
    );
    url.pathname = '/' + schema;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'synthetic-global-voucher-native-secret-'.repeat(2),
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
      db: databases,
      config,
      fixture,
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
