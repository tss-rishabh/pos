import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { readConfig } from '../../../src/config.js';
import { createDatabases } from '../../../src/db/pools.js';
import {
  verifiedMysqlFixture,
  type FixtureValue,
} from '../../operational-reports/verified-mysql-fixture.js';

const tables = ['pos_user', 'stores', 'users', 'tss_settings'] as const;
export async function modelAccountFixture(connection: string) {
  const url = new URL(connection);
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Model account fixtures require isolated localhost MySQL.');
  const schema = 'pos_rewrite_model_accounts_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const admin = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  await admin.query('CREATE DATABASE ' + mysql.escapeId(schema));
  try {
    await admin.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(admin);
    await fixture.create(tables);
    await admin.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
    url.pathname = '/' + schema;
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'model-account-native-fixture-'.repeat(3),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        BUSINESS_TIMEZONE: 'Asia/Kolkata',
      }),
      db = createDatabases(config);
    return {
      admin,
      fixture,
      config,
      db,
      url: url.href,
      async reset() {
        for (const table of tables) await admin.query('DELETE FROM ' + mysql.escapeId(table));
        for (const [id, role, type, staff, superuser, active] of [
          ['900001', 1, 1, 1, 1, 1],
          ['900002', 1, 1, 1, 1, 1],
          ['900003', 1, 1, 1, 0, 1],
          ['900004', 1, 1, 0, 1, 1],
          ['900005', 1, 2, 1, 1, 1],
          ['900006', 2, 1, 1, 1, 1],
          ['900007', 1, 1, 1, 1, 0],
        ] as const)
          await fixture.insert('pos_user', {
            id,
            username: 'fixture-' + id,
            role,
            user_type: type,
            is_staff: staff,
            is_superuser: superuser,
            is_active: active,
          });
        await fixture.insert('tss_settings', {
          id: '1',
          platform: 'STORE_LOCATION_CODE',
          value: JSON.stringify(['MDL-0', 'MDL-1', 'MDL-2']),
        });
      },
      seed(table: string, values: Record<string, FixtureValue>) {
        return fixture.insert(table, values);
      },
      async close() {
        await db.close();
        await admin.changeUser({ database: 'mysql' });
        await admin.query('DROP DATABASE ' + mysql.escapeId(schema));
        await admin.end();
      },
    };
  } catch (error) {
    await admin.changeUser({ database: 'mysql' });
    await admin.query('DROP DATABASE ' + mysql.escapeId(schema));
    await admin.end();
    throw error;
  }
}
