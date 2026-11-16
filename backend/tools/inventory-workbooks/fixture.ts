import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import {
  verifiedMysqlFixture,
  type FixtureValue,
} from '../operational-reports/verified-mysql-fixture.js';
import { readInventoryWorkbookOptions } from '../../src/modules/inventory-workbooks/options.js';

const tables = [
  'products',
  'product_store',
  'categories',
  'has_categories',
  'products_warehouses',
  'has_options',
  'attributes',
  'products_gs1',
  'users_artists',
  'stores',
  'pos_user',
  'user_stores',
  'report_exports',
] as const;
const indexSchema = z.object({
  indexes: z.record(
    z.string(),
    z.array(
      z.object({
        name: z.string().regex(/^[A-Za-z0-9_]+$/),
        column: z.string().regex(/^[A-Za-z0-9_]+$/),
        position: z.number().int(),
        unique: z.boolean(),
      }),
    ),
  ),
  tables: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
});
/** Only a fresh randomized localhost schema is ever mutated. */
export async function inventoryWorkbookFixture(connection: string) {
  const url = new URL(connection);
  if (!['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Workbook fixtures require isolated local MySQL.');
  const schema = `pos_rewrite_workbook_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
  await admin.changeUser({ database: schema });
  const directory = await mkdtemp(join(tmpdir(), 'pos-workbook-native-'));
  const fixture = verifiedMysqlFixture(admin, ['evidence/mysql-inventory-workbooks-schema.json']);
  await fixture.create(tables);
  await admin.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
  const metadata = indexSchema.parse(
    JSON.parse(readFileSync('evidence/mysql-inventory-workbooks-schema.json', 'utf8')) as unknown,
  );
  for (const table of tables) {
    const grouped = new Map<
      string,
      { unique: boolean; columns: { name: string; position: number }[] }
    >();
    for (const value of metadata.indexes[table] || []) {
      if (
        value.name === 'PRIMARY' ||
        /(?:text|blob)/i.test(
          metadata.tables[table]?.find((column) => column.name === value.column)?.type || '',
        )
      )
        continue;
      const group = grouped.get(value.name) || { unique: value.unique, columns: [] };
      group.columns.push({ name: value.column, position: value.position });
      grouped.set(value.name, group);
    }
    for (const [name, value] of grouped)
      await admin.query(
        `CREATE ${value.unique ? 'UNIQUE ' : ''}INDEX ${mysql.escapeId(name)} ON ${mysql.escapeId(table)}(${value.columns
          .sort((a, b) => a.position - b.position)
          .map((column) => mysql.escapeId(column.name))
          .join(',')})`,
      );
  }
  for (const statement of readFileSync('src/modules/operational-reports/migration.sql', 'utf8')
    .split(';')
    .filter((value) => value.trim()))
    await admin.query(statement);
  url.pathname = '/' + schema;
  const config = readConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'workbook-native-fixture-'.repeat(3),
    MYSQL_WRITER_URL: url.href,
    MYSQL_PRIMARY_READER_URL: url.href,
    MYSQL_DATA_READER_URL: url.href,
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  });
  const db = createDatabases(config),
    options = readInventoryWorkbookOptions({
      INVENTORY_WORKBOOK_STAGING_DIRECTORY: directory,
      INVENTORY_WORKBOOK_PAGE_SIZE: '100',
    });
  return {
    admin,
    fixture,
    config,
    db,
    options,
    async reset() {
      await admin.query('DELETE FROM pos_rewrite_report_exports');
      for (const table of tables) await admin.query('DELETE FROM ' + mysql.escapeId(table));
      await fixture.insert('users_artists', { id: '1' });
      for (const id of ['1', '2'])
        await fixture.insert('stores', {
          id,
          store_name: 'Store ' + id,
          phone: '900000000' + id,
          category: 'FRANCHISE',
        });
      await fixture.insert('pos_user', {
        id: '900001',
        username: 'Fixture',
        role: 4,
        user_type: 1,
        is_active: 1,
      });
      await fixture.insert('user_stores', { id: '1', django_user_id: '900001', store_id: '1' });
      await fixture.insert('user_stores', { id: '2', django_user_id: '900001', store_id: '2' });
    },
    product(id: string, values: Record<string, FixtureValue> = {}) {
      return fixture.insert('products', {
        id,
        parent_prod_id: '0',
        prod_type: 1,
        added_by: '1',
        product: 'Fixture shirt',
        erp_product: 'SKU-' + id,
        ...values,
      });
    },
    stock(productId: string, storeId = '1', stock = 3, deleted = 0) {
      return fixture.insert('product_store', {
        product_id: productId,
        store_id: storeId,
        stock,
        is_del: deleted,
        is_avail: 1,
      });
    },
    async close() {
      await db.close();
      await admin.changeUser({ database: 'mysql' });
      await admin.query('DROP DATABASE ' + mysql.escapeId(schema));
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
