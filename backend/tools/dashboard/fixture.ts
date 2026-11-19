import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import {
  verifiedMysqlFixture,
  type FixtureValue,
} from '../operational-reports/verified-mysql-fixture.js';

const tables = [
  'stores',
  'pos_user',
  'user_stores',
  'products',
  'product_store',
  'orders',
  'order_stores',
  'order_status',
] as const;
const metadataSchema = z.object({
  indexes: z
    .record(
      z.string(),
      z.array(
        z.object({
          name: z.string().regex(/^[A-Za-z0-9_]+$/),
          column: z.string().regex(/^[A-Za-z0-9_]+$/),
          position: z.number().int(),
          unique: z.boolean(),
        }),
      ),
    )
    .default({}),
});

/** Mutations are confined to a freshly-created random localhost schema. */
export async function dashboardFixture(connection: string) {
  const url = new URL(connection);
  if (url.protocol !== 'mysql:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('Dashboard fixtures require isolated local MySQL.');
  const schema = 'pos_rewrite_dashboard_' + randomUUID().replaceAll('-', '').slice(0, 12);
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
    const indexes = Object.assign(
      {},
      ...[
        'evidence/mysql-schema.json',
        'evidence/mysql-extra-schema.json',
        'evidence/mysql-inventory-workbooks-schema.json',
      ].map(
        (path) => metadataSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown).indexes,
      ),
    ) as Record<string, z.infer<typeof metadataSchema>['indexes'][string]>;
    for (const table of tables) {
      const grouped = new Map<
        string,
        { unique: boolean; columns: { name: string; position: number }[] }
      >();
      for (const index of indexes[table] || []) {
        if (index.name === 'PRIMARY') continue;
        const value = grouped.get(index.name) || { unique: index.unique, columns: [] };
        value.columns.push({ name: index.column, position: index.position });
        grouped.set(index.name, value);
      }
      for (const [name, index] of grouped)
        await admin.query(
          `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${mysql.escapeId(name)} ON ${mysql.escapeId(table)}(${index.columns
            .sort((a, b) => a.position - b.position)
            .map((value) => mysql.escapeId(value.name))
            .join(',')})`,
        );
    }
    url.pathname = '/' + schema;
    const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'dashboard-native-fixture-'.repeat(3),
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
        let storeIndex = 1;
        for (const [id, active] of [
          ['1', 1],
          ['2', 0],
          ['3', 1],
          ['9007199254740993', 1],
        ] as const)
          await fixture.insert('stores', {
            id,
            store_name: 'Store ' + id,
            is_active: active,
            category: 'FRANCHISE',
            phone: '900000000' + String(storeIndex++),
          });
        for (const [id, role, type, active] of [
          ['900001', 4, 1, 1],
          ['900002', 1, 1, 1],
          ['900003', 1, 2, 1],
          ['900004', 5, 1, 0],
        ] as const)
          await fixture.insert('pos_user', {
            id,
            username: 'operator-' + id,
            role,
            user_type: type,
            is_active: active,
          });
        let mapping = 1;
        for (const [user, store] of [
          ['900001', '1'],
          ['900001', '2'],
          ['900001', '9007199254740993'],
          ['900003', '1'],
        ])
          await fixture.insert('user_stores', {
            id: String(mapping++),
            django_user_id: user!,
            store_id: store!,
          });
        for (const id of ['1', '2', '3'])
          await fixture.insert('order_status', { id, order_status: 'Status ' + id });
      },
      product(id: string, values: Record<string, FixtureValue> = {}) {
        return fixture.insert('products', {
          id,
          parent_prod_id: '0',
          prod_type: 1,
          added_by: '1',
          product: 'Synthetic item ' + id,
          erp_product: 'SKU-' + id,
          ...values,
        });
      },
      stock(id: string, store = '1', values: Record<string, FixtureValue> = {}) {
        return fixture.insert('product_store', {
          product_id: id,
          store_id: store,
          stock: 0,
          is_del: 0,
          is_avail: 1,
          ...values,
        });
      },
      order(id: string, createdAt: string, status = 1) {
        return fixture.insert('orders', { id, created_at: createdAt, order_status: status });
      },
      association(id: string, orderId: string, storeId = '1') {
        return fixture.insert('order_stores', {
          id,
          order_id: orderId,
          store_id: storeId,
          counter_id: '1',
        });
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
