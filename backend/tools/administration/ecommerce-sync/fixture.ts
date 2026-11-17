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
  'stores',
  'user_stores',
  'hold_stock_store',
  'pos_hold_stock_logs',
  'product_stocks',
  'product_inventory_logs',
  'pos_inventory_sync_log',
  'products_inventory_logs',
  'pos_product_inventory_logs',
  'attributes',
  'has_options',
  'tss_settings',
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
export async function ecommerceFixture(connection: string) {
  const url = new URL(connection);
  if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Ecommerce fixtures require isolated localhost MySQL.');
  const schema = 'pos_rewrite_ecommerce_sync_' + randomUUID().replaceAll('-', '').slice(0, 12);
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
      'src/modules/administration/migration.sql',
      'src/modules/administration/import-migration.sql',
      'src/modules/administration/parent-store-imports/migration.sql',
      'src/modules/administration/settings-migration.sql',
      'src/modules/administration/ecommerce-sync/migration.sql',
    ])
      for (const statement of readFileSync(migration, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await admin.query(statement);
    url.pathname = '/' + schema;
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'ecommerce-sync-native-fixture-'.repeat(3),
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
        await admin.query('DROP TRIGGER IF EXISTS reject_parent_audit');
        for (const table of [
          'pos_rewrite_ecommerce_inventory_sync_rows',
          'pos_rewrite_ecommerce_inventory_syncs',
          'pos_rewrite_settings_effects',
          'pos_rewrite_settings_mutations',
          'pos_rewrite_ecommerce_changes',
          'pos_rewrite_parent_store_import_audits',
          'pos_rewrite_inventory_import_rows',
          'pos_rewrite_inventory_imports',
          'pos_rewrite_administration_outbox',
          ...tables,
        ])
          await admin.query('DELETE FROM ' + mysql.escapeId(table));
        for (const [id, role, type, active] of [
          ['900001', 1, 1, 1],
          ['900002', 4, 1, 1],
          ['900003', 5, 1, 1],
          ['900004', 1, 2, 1],
          ['900005', 2, 1, 1],
        ] as const)
          await fixture.insert('pos_user', {
            id,
            username: 'fixture-' + id,
            role,
            user_type: type,
            is_active: active,
          });
        for (const id of ['1', '2', '3', '4'])
          await fixture.insert('stores', {
            id,
            store_name: 'Store ' + id,
            category: id === '2' ? 'IN_HOUSE' : 'FRANCHISE',
            is_active: id === '4' ? 0 : 1,
            phone: '900000000' + id,
          });
        for (const actor of ['900002', '900003', '900004', '900005'])
          for (const store of ['1', '2'])
            await fixture.insert('user_stores', { django_user_id: actor, store_id: store });
        for (const [id, parent, type, deleted] of [
          ['10', '0', 3, 0],
          ['11', '10', 1, 0],
          ['12', '10', 1, 1],
          ['13', '10', 1, 1],
          ['20', '0', 1, 0],
          ['30', '0', 8, 0],
          ['9007199254740993', '0', 1, 0],
        ] as const)
          await fixture.insert('products', {
            id,
            parent_prod_id: parent,
            prod_type: type,
            is_del: deleted,
            product: 'Synthetic ' + id,
          });
        for (const [id, store, product, stock, deleted, available] of [
          ['101', '1', '10', 7, 1, 0],
          ['102', '1', '11', 9, 0, 1],
          ['103', '1', '12', 5, 0, 0],
          ['104', '1', '13', 6, 1, 1],
          ['105', '2', '12', 4, 0, 0],
          ['106', '1', '20', 8, 0, 0],
          ['107', '1', '30', 6, 0, 0],
        ] as const)
          await fixture.insert('product_store', {
            id,
            store_id: store,
            product_id: product,
            stock,
            is_del: deleted,
            is_avail: available,
          });
        await fixture.insert('hold_stock_store', { store_id: '1', product_id: '11', stock: 3 });
        await admin.query(
          "UPDATE stores SET location_code=CONCAT('S',id),ecom_delivery=1,ecom_threshold=CASE WHEN id=1 THEN 5 ELSE 1 END",
        );
        await admin.query('UPDATE product_store SET stock=0 WHERE product_id=10');
        for (const [id, parent] of [
          ['11', '10'],
          ['12', '10'],
          ['13', '10'],
          ['20', '0'],
          ['30', '0'],
          ['9007199254740993', '0'],
        ] as const)
          await fixture.insert('product_stocks', {
            prod_id: id,
            parent_prod_id: parent,
            stock: '999',
            stocked: 1,
          });
        await fixture.insert('attributes', { id: '1', attr: 'Size' });
        for (const [id, size] of [
          ['11', 'M'],
          ['12', 'L'],
          ['13', 'S'],
        ] as const)
          await fixture.insert('has_options', { prod_id: id, attr_id: '1', attr_val: size });
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
