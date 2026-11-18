import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

// Production-schema changes the global voucher writer currently requires (see
// backend/parity/w2-followups.md). Applied only to this disposable fixture schema.
const legacyCandidateDdl = [
  'ALTER TABLE coupons MODIFY end_date DATETIME NULL',
  'ALTER TABLE gift_vouchers MODIFY start_date DATETIME NULL, MODIFY end_date DATETIME NULL',
  "ALTER TABLE gift_voucher_history MODIFY platform enum('ORDER_PLACED','ORDER_CANCELLED','ORDER_REFUND','ORDER_MONEY','ORDER_RETURN','PAYMENT_FAILED','PRODUCT_RETURN','COURIER_COMPENSATION','DEFECTIVE_PRODUCT','PRODUCT_MISSING','PRODUCT_OUT_OF_STOCK','MISC_COMPENSATION','GV_ADD') CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NULL",
];
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
    for (const path of [
      'src/modules/administration/migration.sql',
      'src/modules/customer-contacts/contact-revisions-migration.sql',
      'src/modules/checkout/migrations/0002_checkout.sql',
      'src/modules/checkout/migrations/0008_checkout_draft_binding.sql',
      'src/modules/checkout/migrations/0015_gift_card_issuance.sql',
      'src/modules/global-vouchers/migration.sql',
      'src/modules/customer-otp/migration.sql',
    ]) {
      for (const statement of readFileSync(path, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
    }
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
      async applyLegacyCandidate() {
        for (const statement of legacyCandidateDdl) await connection.query(statement);
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
