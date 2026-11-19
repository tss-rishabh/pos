import mysql from 'mysql2/promise';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as models from '../../src/db/legacy-schema.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { readConfig } from '../../src/config.js';
import { financeFeedOptions, financeFeedService } from '../../src/modules/finance/feed.js';
import { feedQueries } from '../../src/modules/finance/feed-query.js';
import {
  feedLineSchema,
  feedSaleLineSchema,
  reconciliationPage,
  reconciliationRecords,
} from '../../src/modules/finance/feed-domain.js';
import { createProductionTables } from '../helpers/production-schema.js';

const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('finance reconciliation on isolated local MySQL', () => {
  const schema = `pos_rewrite_feed_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
    tables = new Map(Object.values(models).map((model) => [getTableConfig(model).name, model]));
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  function db() {
    if (!databases) throw new Error('Fixture not initialized');
    return databases;
  }
  async function insert(name: string, overrides: Record<string, string | number | null>) {
    const model = tables.get(name);
    if (!model) throw new Error('Fixture mapping not found');
    const cfg = getTableConfig(model),
      columns = cfg.columns.filter(
        (column) =>
          !('autoIncrement' in column && column.autoIncrement && !(column.name in overrides)),
      );
    const known = new Set(cfg.columns.map((column) => column.name));
    if (Object.keys(overrides).some((key) => !known.has(key)))
      throw new Error('Fixture overrides contain an unmapped column.');
    const values = columns.map((column) => {
      if (column.name in overrides) return overrides[column.name];
      if (!column.notNull) return null;
      const type = column.getSQLType().toLowerCase();
      if (type.startsWith('datetime') || type.startsWith('timestamp')) return '2026-11-16 12:00:00';
      if (type === 'date') return '2026-11-16';
      if (/^(bigint|int|smallint|tinyint|double|float|decimal|mediumint|boolean)/.test(type))
        return 0;
      return '';
    });
    await admin!.query(
      `INSERT INTO ${mysql.escapeId(cfg.name)} (${columns.map((column) => mysql.escapeId(column.name)).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      values,
    );
  }
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Finance feed fixtures require local MySQL.');
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
    // Production DDL already has refund_requests and the has_products/tss_money_history columns
    // the source SQL reads outside Django's model (hp_tss_points_used, store_disc_pg, has_product_id).
    await createProductionTables(admin, [
      'orders',
      'has_products',
      'amount_to_be_refunded_log',
      'tss_money_history',
      'users',
      'payment_method',
      'payment_status',
      'order_stores',
      'stores',
      'pos_terminal_transactions',
      'pos_paytm_transactions',
      'pos_terminal_payment_modes',
      'store_counters',
      'return_orders',
      'refund_requests',
    ]);
    await insert('users', { id: 1, email: 'customer@example.test' });
    await insert('stores', { id: 1, store_name: 'Fixture store', location_code: 'FIXTURE' });
    await insert('store_counters', { id: 1, counter_name: 'Fixture counter', store_id: 1 });
    await insert('payment_method', { id: 14, name: 'POC' });
    await insert('payment_status', { id: 1, payment_status: 'Paid' });
    for (const [id, date] of [
      [1001, '2026-11-16 10:00:00'],
      [1002, '2026-11-15 10:00:00'],
    ] as const) {
      await insert('orders', {
        id,
        user_id: 1,
        order_ref_no: `FIXTURE-${id}`,
        payment_method: 14,
        payment_status: 1,
        order_status: 1,
        pay_amt: 315,
        order_amt: 315,
        created_at: date,
      });
      await insert('order_stores', {
        id: id - 1000,
        order_id: id,
        store_id: 1,
        counter_id: 1,
        offline_payment: '300.00',
        online_other_payment: '15.00',
      });
    }
    for (const [id, order, prod, amount, mode] of [
      [501, 1001, 101, 100, 'cash'],
      [502, 1001, 102, 200, 'tss_money'],
      [503, 1002, 103, 50, 'cash'],
    ] as const) {
      await insert('has_products', {
        id,
        order_id: order,
        prod_id: prod,

        price: amount * 1.05,
        pre_gst_amt: amount,
        gst: 5,
        qty: 1,
        return_mode: 1,
        status: 'RETURN_COMPLETED',
      });
      await insert('amount_to_be_refunded_log', {
        id: id - 500,
        order_id: order,
        prod_id: prod,
        has_product_id: id,
        is_refunded: 1,
        refunded_amt: id === 501 ? 5.005 : id === 502 ? 10 : 3,
        refund_mode: mode,
      });
    }
    for (const [id, order, prod, hp] of [
      [1, 1001, 101, 501],
      [2, 1002, 103, 503],
    ] as const)
      await insert('return_orders', {
        id,
        order_id: order,
        prod_id: prod,
        has_product_id: hp,
        store_id: 1,
        order_status: 6,
        created_at: '2026-11-16 13:00:00',
      });
    await admin.query(
      "INSERT INTO refund_requests(id,order_id,product_id,has_product_id,created_at,is_approved,refund_method) VALUES(1,1001,102,502,'2026-11-16 14:00:00','APPROVED','tss_money')",
    );
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'finance-feed-mysql-fixture-'.repeat(3),
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
  it('matches the original SQL rows under strict SQL mode and includes returns from older sales', async () => {
    const queries = feedQueries('2026-11-16', '2026-11-17', 'FIXTURE');
    const [modeRows] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT @@session.sql_mode AS mode',
    );
    const originalMode = String(modeRows[0]?.mode || '');
    let saleRows: unknown, returnRows: unknown;
    try {
      await admin!.query('SET SESSION sql_mode=?', [
        originalMode
          .split(',')
          .filter((value) => value !== 'ONLY_FULL_GROUP_BY')
          .join(','),
      ]);
      [saleRows] = await admin!.query(
        queries.source.sales.replaceAll('%s', '?'),
        queries.source.args,
      );
      [returnRows] = await admin!.query(queries.source.returns.replaceAll('%s', '?'), [
        ...queries.source.args,
        ...queries.source.args,
      ]);
    } finally {
      await admin!.query('SET SESSION sql_mode=?', [originalMode]);
    }
    const expected = reconciliationPage(
      reconciliationRecords(
        z.array(feedSaleLineSchema).parse(saleRows),
        z.array(feedLineSchema).parse(returnRows),
      ),
      1,
      100,
    );
    const service = financeFeedService(
      readConfig({
        NODE_ENV: 'test',
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'finance-feed-service-fixture-'.repeat(3),
      }),
      db(),
      financeFeedOptions({ BQ_FINANCE_RECONCILIATION_RETURNS: 'fixture-project.finance.returns' }),
      {
        // Native pinned-source rows are the independent compatible-view oracle,
        // not a production fallback or a claim of BigQuery publication acceptance.
        async queryReport(statement) {
          expect(statement).toContain('`fixture-project.finance.returns`');
          return z.array(feedLineSchema).parse(returnRows);
        },
      },
      () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
    );
    const actual = await service.orders({
      from: '2026-11-16',
      to: '2026-11-16',
      storeCode: 'FIXTURE',
      page: 1,
      pageSize: 100,
    });
    expect(actual).toEqual(expected);
    expect(actual.pagination.total_records).toBe(4);
    expect(
      actual.data.some(
        (record) => record.order_id === '1002' && record.transaction_type === 'RETURN',
      ),
    ).toBe(true);
    expect(
      actual.data.some(
        (record) => record.order_id === '1002' && record.transaction_type === 'SALE',
      ),
    ).toBe(false);
  });
});
