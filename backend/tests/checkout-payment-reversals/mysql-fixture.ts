import mysql from 'mysql2/promise';
import { createDatabases } from '../../src/db/pools.js';
import { readConfig } from '../../src/config.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

/** Production tables only: payments write no rewrite tables. */
export async function paymentMysqlFixture(template: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_checkout_test'
  )
    throw new Error('Explicit isolated localhost checkout template required.');
  const schema = `pos_rewrite_payments_${process.pid}_${crypto.randomUUID().slice(0, 8)}`,
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
  await connection.changeUser({ database: schema });
  const fixture = verifiedMysqlFixture(connection);
  try {
    await fixture.create([
      'users',
      'user_eav',
      'pos_user',
      'stores',
      'store_counters',
      'user_stores',
      'products',
      'payment_status',
      'exchange_order_log',
      'has_categories',
      'categories',
      'pos_online_orders',
      'store_day_banking',
      'store_cash_opening_balance',
      'product_store',
      'orders',
      'order_stores',
      'has_products',
      'order_status',
      'comments',
      'gift_vouchers',
      'gift_card_collection',
      'pos_transaction_logs',
      'store_day_close',
      'return_orders',
      'amount_to_be_refunded_log',
      'pos_terminal_transactions',
      'pos_paytm_transactions',
      'pos_terminal_payment_modes',
      'pos_machines',
      'pos_paytm_machines',
    ]);
    url.pathname = '/' + schema;
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'isolated-payment-fixture-secret-'.repeat(3),
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        DAY_CLOSE_ENABLED_STORE_IDS: 'all',
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      }),
      db = createDatabases(config);
    return {
      connection,
      fixture,
      config,
      db,
      schema,
      async close() {
        await db.close();
        await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
        await connection.end();
      },
    };
  } catch (error) {
    await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
    await connection.end();
    throw error;
  }
}
