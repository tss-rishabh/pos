import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  orderTransactionsReportService,
  orderTransactionsInputSchema,
  orderTransactionsOptions,
} from '../../src/modules/operational-reports/order-transactions.js';
import {
  orderReportLineSchema,
  preparedOrderRecords,
} from '../../src/modules/operational-reports/order-report-domain.js';
import { combinedOrderQueries } from '../../src/modules/operational-reports/order-report-query.js';
const connection = process.env.MYSQL_INTEGRATION_URL;
const columnSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_]\w*$/),
  type: z
    .string()
    .regex(/^(?:[a-z]+(?:\(\d+(?:,\d+)?\))?(?: unsigned)?|enum\((?:'[^'\\;]*'(?:,)?)+\))$/i),
  nullable: z.boolean(),
  key: z.string(),
  extra: z.string(),
});
const metadataSchema = z.object({
  tables: z.record(z.string(), z.array(columnSchema)),
  errors: z.array(z.unknown()),
});
describe.skipIf(!connection)(
  'combined store/online order reports on verified-schema local MySQL',
  () => {
    const schema = `pos_rewrite_order_report_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      metadata = {
        ...metadataSchema.parse(
          JSON.parse(readFileSync('evidence/mysql-schema.json', 'utf8')) as unknown,
        ).tables,
        ...metadataSchema.parse(
          JSON.parse(readFileSync('evidence/mysql-extra-schema.json', 'utf8')) as unknown,
        ).tables,
      },
      tables = [
        'orders',
        'has_products',
        'amount_to_be_refunded_log',
        'tss_money_history',
        'order_attributes',
        'users',
        'products',
        'categories',
        'has_categories',
        'payment_method',
        'payment_status',
        'order_stores',
        'stores',
        'pos_terminal_transactions',
        'pos_paytm_transactions',
        'pos_terminal_payment_modes',
        'salespersons',
        'store_counters',
        'store_pg_disc_addons',
        'refund_requests',
        'return_orders',
        'pos_online_orders',
        'comments',
      ];
    const user: Principal = {
        id: '10',
        name: 'Fixture',
        email: 'fixture@example.test',
        role: 4,
        userType: 1,
        storeIds: ['1'],
      },
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'combined-order-fixture-'.repeat(3),
      }),
      clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
    let admin: mysql.Connection | undefined,
      databases: Databases | undefined,
      created = false;
    function db() {
      if (!databases) throw new Error('Fixture not initialized');
      return databases;
    }
    async function insert(table: string, overrides: Record<string, string | number | null>) {
      const columns = metadata[table];
      if (
        !columns ||
        Object.keys(overrides).some((name) => !columns.some((column) => column.name === name))
      )
        throw new Error('Fixture column is unverified.');
      const selected = columns.filter(
          (column) => !column.extra.includes('auto_increment') || column.name in overrides,
        ),
        values = selected.map((column) => {
          if (column.name in overrides) return overrides[column.name];
          if (column.nullable) return null;
          if (/^(date|timestamp)/i.test(column.type))
            return column.type === 'date' ? '2026-11-16' : '2026-11-16 10:00:00';
          if (column.type.startsWith('time')) return '10:00:00';
          if (
            /^(bigint|int|smallint|tinyint|double|float|decimal|mediumint|bit)/i.test(column.type)
          )
            return 0;
          if (column.type.startsWith('enum'))
            return /^enum\('([^']*)'/.exec(column.type)?.[1] || '';
          return column.type === 'json' ? '{}' : '';
        });
      await admin!.query(
        `INSERT INTO ${mysql.escapeId(table)} (${selected.map((column) => mysql.escapeId(column.name)).join(',')}) VALUES (${selected.map(() => '?').join(',')})`,
        values,
      );
    }
    beforeAll(async () => {
      const url = new URL(connection!);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname))
        throw new Error('Combined report fixtures require local MySQL.');
      admin = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
      await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
      created = true;
      await admin.changeUser({ database: schema });
      for (const table of tables) {
        const columns = metadata[table];
        if (!columns) throw new Error('Fixture table metadata is unavailable.');
        const keys = columns
          .filter((column) => column.key === 'PRI')
          .map((column) => mysql.escapeId(column.name));
        await admin.query(
          `CREATE TABLE ${mysql.escapeId(table)} (${columns.map((column) => mysql.escapeId(column.name) + ' ' + column.type + (column.nullable ? ' NULL' : ' NOT NULL') + (column.extra.includes('auto_increment') ? ' AUTO_INCREMENT' : '')).join(',')}${keys.length ? ',PRIMARY KEY(' + keys.join(',') + ')' : ''}) ENGINE=InnoDB`,
        );
      }
      await insert('stores', { id: 1, store_name: 'Fixture one', location_code: 'FIXTURE-1' });
      await insert('stores', { id: 2, store_name: 'Fixture two', location_code: 'FIXTURE-2' });
      await insert('users', {
        id: 1,
        firstname: 'Fixture',
        lastname: 'Customer',
        email: 'customer@example.test',
      });
      await insert('products', { id: 100, product: 'Fixture parent', parent_prod_id: 0 });
      await insert('products', { id: 101, product: 'Fixture variant', parent_prod_id: 100 });
      await insert('categories', { id: 153, category: 'Preferred fixture', hsn_code: 6100 });
      await insert('categories', { id: 2, category: 'Other fixture', hsn_code: 6200 });
      await insert('has_categories', { id: 2, prod_id: 100, cat_id: 2 });
      await insert('has_categories', { id: 99, prod_id: 100, cat_id: 153 });
      await insert('store_counters', { id: 1, counter_name: 'Fixture counter' });
      await insert('payment_method', { id: 14, name: 'Fixture cash' });
      await insert('payment_status', { id: 4, payment_status: 'Fixture paid' });
      for (const [id, createdAt, store] of [
        [10001, '2026-11-16 10:00:00', 1],
        [10002, '2026-11-15 10:00:00', 1],
        [10003, '2026-11-16 11:00:00', 2],
        [10004, '2026-11-10 10:00:00', 1],
        [10005, '2026-11-10 10:00:00', 1],
      ] as const) {
        await insert('orders', {
          id,
          user_id: 1,
          created_at: createdAt,
          order_status: 3,
          payment_status: 4,
          payment_method: 14,
          order_amt: 118,
          pay_amt: 118,
          order_ref_no: `FIX-${id}`,
          parent_order_id: 0,
        });
        if (id < 10004)
          await insert('order_stores', {
            id: id - 10000,
            order_id: id,
            store_id: store,
            counter_id: 1,
            offline_payment: 118,
            order_invoice: `FIX/INV/${id}`,
          });
        else
          await insert('pos_online_orders', {
            order_id: id,
            store_id: store,
            created_at: '2026-11-16 10:00:00',
          });
        await insert('has_products', {
          id: id - 9000,
          order_id: id,
          prod_id: 101,
          sub_prod_id: 0,
          qty: 1,
          status: id === 10002 ? 'PRODUCT_RETURNED' : id === 10005 ? 'CANCELLED' : 'DELIVERED',
          return_mode: id === 10002 ? 3 : 0,
          price: 118,
          gst: 18,
          pre_gst_amt: 100,
          pg_disc: 0,
          store_disc_pg: 0,
          hp_tss_points_used: 0,
          disc: 0,
          created_at: createdAt,
          updated_at: '2026-11-16 12:00:00',
        });
      }
      await insert('return_orders', {
        id: 1,
        order_id: 10002,
        prod_id: 101,
        has_product_id: 1002,
        store_id: 1,
        qty: 1,
        order_status: 6,
        credit_note_no: 'FIX/CREDIT/10002',
        created_at: '2026-11-16 12:00:00',
      });
      await insert('amount_to_be_refunded_log', {
        id: 1,
        order_id: 10002,
        prod_id: 101,
        has_product_id: 1002,
        refunded_amt: 118,
        is_refunded: 1,
        refund_mode: 'cash',
      });
      await insert('comments', {
        order_id: 10005,
        prod_id: 101,
        has_product_id: 1005,
        status_id: 4,
        created_at: '2026-11-16 13:00:00',
      });
      url.pathname = '/' + schema;
      databases = createDatabases(
        readConfig({
          NODE_ENV: 'test',
          SESSION_SECRET: 'combined-order-mysql-config-'.repeat(3),
          MYSQL_PRIMARY_READER_URL: url.href,
          MYSQL_DATA_READER_URL: url.href,
          MYSQL_WRITER_URL: url.href,
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        }),
      );
    });
    afterAll(async () => {
      await databases?.close();
      if (admin && created) {
        await admin.changeUser({ database: 'mysql' });
        await admin.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      }
      await admin?.end();
    });
    it('preserves source store/online branches and order-vs-return date semantics with strict grouping', async () => {
      let projected: z.infer<typeof orderReportLineSchema>[] = [];
      const service = orderTransactionsReportService(
          config,
          db(),
          orderTransactionsOptions({
            BQ_STORE_ORDER_SALES_VIEW: 'fixture-project.reports.store_sales',
            BQ_STORE_ORDER_RETURNS_VIEW: 'fixture-project.reports.store_returns',
            BQ_ONLINE_ORDER_SALES_VIEW: 'fixture-project.reports.online_sales',
            BQ_ONLINE_ORDER_RETURNS_VIEW: 'fixture-project.reports.online_returns',
          }),
          {
            async queryReport(statement) {
              // Explicit native source-projection fixture for the warehouse port.
              // The literal original SQL is independently compared below.
              return statement.endsWith(' AS count') ? [{ count: projected.length }] : projected;
            },
          },
          clock,
        ),
        [mode] = await admin!.query<mysql.RowDataPacket[]>('SELECT @@SESSION.sql_mode AS value'),
        original = String(mode[0]?.value || '');
      for (const source of ['store', 'online'] as const)
        for (const dateType of ['order_date', 'return_date'] as const) {
          const input = orderTransactionsInputSchema.parse({
            from: '2026-11-16T00:00:00',
            to: '2026-11-16T23:59:59',
            storeIds: ['1'],
            source,
            dateType,
          });
          const compiled = combinedOrderQueries(
              source,
              dateType,
              '2026-11-16 00:00:00',
              '2026-11-16 23:59:59',
              ['1'],
            ),
            raw = await db()
              .get('data')
              .execute(
                sql`(${compiled.sales}) UNION ALL (${compiled.returns}) ORDER BY transaction_date DESC,id DESC`,
              ),
            checked = z.array(orderReportLineSchema).safeParse(raw[0]);
          if (!checked.success)
            throw new Error(
              'Fixture projection fields: ' +
                checked.error.issues.map((issue) => issue.path.join('.')).join(','),
            );
          projected = checked.data;
          const result = await service.read(user, input),
            query = execFileSync(
              'python3',
              [
                'tools/operational-reports/order-report-query-oracle.py',
                source,
                dateType,
                '2026-11-16 00:00:00',
                '2026-11-16 23:59:59',
                '1',
              ],
              { encoding: 'utf8' },
            );
          let expected: mysql.RowDataPacket[] = [];
          try {
            await admin!.query('SET SESSION sql_mode=?', [
              original
                .split(',')
                .filter((value) => value !== 'ONLY_FULL_GROUP_BY')
                .join(','),
            ]);
            [expected] = await admin!.query<mysql.RowDataPacket[]>(query);
          } catch {
            throw new Error('Original combined report fixture query failed.');
          } finally {
            await admin!.query('SET SESSION sql_mode=?', [original]);
          }
          const normalized = z.array(orderReportLineSchema).parse(expected);
          expect(result.reader).toBe(dateType === 'return_date' ? 'bigquery' : 'data');
          expect(result.total).toBe(expected.length);
          expect(result.data).toEqual(preparedOrderRecords(normalized));
          expect(result.data.every((row) => row.product_category === 'Preferred fixture')).toBe(
            true,
          );
          if (source === 'store')
            expect(result.data.some((row) => row.order_id === '10002')).toBe(
              dateType === 'return_date',
            );
          else expect(result.data.some((row) => row.order_id === '10004')).toBe(true);
        }
    });
  },
);
