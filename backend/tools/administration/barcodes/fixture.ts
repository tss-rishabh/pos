import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import { readConfig } from '../../../src/config.js';
import { createDatabases } from '../../../src/db/pools.js';
import {
  verifiedMysqlFixture,
  type FixtureValue,
} from '../../operational-reports/verified-mysql-fixture.js';

const tables = [
  'pos_user',
  'products',
  'product_store',
  'products_gs1',
  'pos_special_permission_activity_log',
  'countries',
  'stores',
] as const;
const indexMetadata = z.object({
  indexes: z
    .record(
      z.string(),
      z.array(
        z.object({
          name: z.string().regex(/^[A-Za-z0-9_]+$/),
          column: z.string().regex(/^[A-Za-z0-9_]+$/),
          position: z.number(),
          unique: z.boolean(),
        }),
      ),
    )
    .default({}),
});
export async function barcodeFixture(connection: string) {
  const url = new URL(connection);
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Barcode fixtures require isolated localhost MySQL.');
  const schema = 'pos_rewrite_barcodes_' + randomUUID().replaceAll('-', '').slice(0, 12);
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
    const fixture = verifiedMysqlFixture(admin, ['evidence/mysql-inventory-workbooks-schema.json']);
    await fixture.create(tables);
    await admin.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
    const metadata = {
      ...indexMetadata.parse(
        JSON.parse(readFileSync('evidence/mysql-extra-schema.json', 'utf8')) as unknown,
      ).indexes,
      ...indexMetadata.parse(
        JSON.parse(
          readFileSync('evidence/mysql-inventory-workbooks-schema.json', 'utf8'),
        ) as unknown,
      ).indexes,
    };
    for (const table of tables) {
      const indexes = new Map<
        string,
        { unique: boolean; columns: { name: string; position: number }[] }
      >();
      for (const row of metadata[table] || []) {
        if (row.name === 'PRIMARY') continue;
        const value = indexes.get(row.name) || { unique: row.unique, columns: [] };
        value.columns.push({ name: row.column, position: row.position });
        indexes.set(row.name, value);
      }
      for (const [name, index] of indexes)
        await admin.query(
          `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${mysql.escapeId(name)} ON ${mysql.escapeId(table)}(${index.columns
            .sort((a, b) => a.position - b.position)
            .map((row) => mysql.escapeId(row.name))
            .join(',')})`,
        );
    }
    for (const migration of [
      'src/modules/catalog-details/maintenance-migration.sql',
      'src/modules/administration/barcodes/migration.sql',
    ])
      for (const statement of readFileSync(migration, 'utf8')
        .split(';')
        .filter((value) => value.trim()))
        await admin.query(statement);
    url.pathname = '/' + schema;
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'barcode-native-fixture-'.repeat(3),
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
        await admin.query('DROP TRIGGER IF EXISTS reject_barcode_audit');
        for (const table of [
          'pos_rewrite_catalog_reconciliations',
          'pos_rewrite_catalog_deliveries',
          'pos_rewrite_catalog_commands',
          ...tables,
          'pos_rewrite_barcode_assignments',
          'pos_rewrite_catalog_locks',
        ])
          await admin.query('DELETE FROM ' + mysql.escapeId(table));
        for (const [id, role, type, active] of [
          ['900001', 1, 1, 1],
          ['900002', 2, 1, 1],
          ['900003', 3, 1, 1],
          ['900004', 4, 1, 1],
          ['900005', 1, 2, 1],
          ['900006', 1, 1, 0],
        ] as const)
          await fixture.insert('pos_user', {
            id,
            username: 'fixture-' + id,
            role,
            user_type: type,
            is_active: active,
          });
        for (const id of ['11', '12', '13', '14', '15', '9007199254740993'])
          await fixture.insert('products', {
            id,
            product: 'Synthetic item ' + id,
            parent_prod_id: 0,
            prod_type: 1,
          });
        let index = 1;
        for (const [id, category, active] of [
          ['1', 'FRANCHISE', 1],
          ['2', 'IN_HOUSE', 1],
          ['3', 'FRANCHISE', 1],
          ['4', 'FRANCHISE', 0],
        ] as const)
          await fixture.insert('stores', {
            id,
            store_name: 'Store ' + id,
            category,
            is_active: active,
            phone: '900000000' + String(index++),
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
