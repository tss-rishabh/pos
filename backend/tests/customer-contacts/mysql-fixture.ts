import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { createDatabases } from '../../src/db/pools.js';
import { readConfig } from '../../src/config.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

export async function customerContactFixture(
  template: string,
  tables: readonly string[],
  schemaTemplate:
    | 'pos_rewrite_customer_contacts_test'
    | 'pos_rewrite_customer_otp_test' = 'pos_rewrite_customer_contacts_test',
) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/' + schemaTemplate
  )
    throw new Error('Contact fixtures require the explicit isolated local schema template.');
  const schema = `${schemaTemplate}_${process.pid}_${randomUUID().slice(0, 8)}`;
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
      'evidence/mysql-customer-contact-schema.json',
      'evidence/mysql-global-benefits-schema.json',
    ]);
    await fixture.create(tables);
    for (const path of [
      'src/modules/customer-contacts/migration.sql',
      'src/modules/customer-contacts/contact-revisions-migration.sql',
    ])
      for (const statement of readFileSync(path, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
    url.pathname = '/' + schema;
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'synthetic-contact-native-fixture-secret-'.repeat(2),
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
      db: databases,
      config,
      fixture,
      url: url.href,
      schema,
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
