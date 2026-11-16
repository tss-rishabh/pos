import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

/** Uses physical verified schemas/defaults; the only DDL is in an isolated local database. */
export async function websiteHandoffFixture(template: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_customer_website_handoff_test'
  )
    throw new Error('Website handoff fixtures require the isolated localhost schema template.');
  const name = `pos_rewrite_website_handoff_${process.pid}_${randomUUID().slice(0, 8)}`;
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
    await connection.query(`CREATE DATABASE ${mysql.escapeId(name)}`);
    await connection.changeUser({ database: name });
    const fixture = verifiedMysqlFixture(connection, [
      'evidence/mysql-customer-contact-schema.json',
      'evidence/mysql-global-benefits-schema.json',
    ]);
    await fixture.create(['users', 'pos_user', 'stores', 'store_counters', 'user_stores']);
    for (const path of [
      'src/modules/customer-contacts/migration.sql',
      'src/modules/customer-contacts/contact-revisions-migration.sql',
      'src/modules/administration/migration.sql',
      'src/modules/checkout/migrations/0002_checkout.sql',
      'src/modules/checkout/migrations/0008_checkout_draft_binding.sql',
      'migrations/0002_auth_sessions.sql',
      'migrations/0006_operator_auth_epochs.sql',
      'src/modules/customer-otp/migration.sql',
      'src/modules/customer-website-handoff/migration.sql',
    ])
      for (const statement of readFileSync(path, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
    url.pathname = '/' + name;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'synthetic-website-handoff-session-secret-'.repeat(2),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_DATA_READER_URL: url.href,
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    const databases = createDatabases(config);
    db = databases;
    return {
      config,
      db: databases,
      connection,
      fixture,
      async reset() {
        const [rows] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES');
        for (const row of rows)
          await connection.query('DELETE FROM ' + mysql.escapeId(String(Object.values(row)[0])));
      },
      async close() {
        await databases.close();
        await connection.query(`DROP DATABASE ${mysql.escapeId(name)}`);
        await connection.end();
      },
    };
  } catch (error) {
    await db?.close();
    await connection
      .query(`DROP DATABASE IF EXISTS ${mysql.escapeId(name)}`)
      .catch(() => undefined);
    await connection.end();
    throw error;
  }
}
