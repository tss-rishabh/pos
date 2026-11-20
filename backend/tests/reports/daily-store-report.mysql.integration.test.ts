import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { reportService } from '../../src/modules/reports.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';
import { createProductionTables } from '../helpers/production-schema.js';
import {
  verifiedMysqlFixture,
  type FixtureValue,
} from '../../tools/operational-reports/verified-mysql-fixture.js';

/**
 * Daily store report on MySQL (today's range), end to end against the pinned source.
 *
 * The oracle (`tests/golden/reports/daily-store-report-mysql.json`) ran the pinned
 * `report/datatables/daily_store_report.py` `AjaxDailyStoreReportView.datatables`
 * (backend-pos-web 78d5b63) with Django 4.2.5 over this exact fixture schema: the
 * excluded-products resolution, both `daily_store_rollup_query` statements from
 * `report/report_queries.py`, `day_close_services.banking_map`, `_merge_rows` and `_totals`.
 * Only the BigQuery footfall/target lookups were replaced by the fixed maps in the input,
 * which the rewrite's warehouse auxiliary returns too. The rewrite's `reportService.daily`
 * must return the same rows and footer.
 */
const connection = process.env.MYSQL_INTEGRATION_URL;
const tables = [
  'orders',
  'has_products',
  'order_attributes',
  'users',
  'products',
  'categories',
  'has_categories',
  'payment_status',
  'order_stores',
  'pos_online_orders',
  'stores',
  'exchange_order_log',
  'store_day_banking',
];
const footfall: [string, string, number][] = [
  ['Store one', '2026-11-16', 40],
  [' Store two ', '2026-11-16', 7],
];
const target: [string, string, number][] = [['Store one', '2026-11-16', 10000]];
/**
 * Both stubs stand for the same BigQuery lookup (legacy `helpers/bigquery.py:34-63`, rewrite
 * `warehouse.ts` `dimensions`): rows whose `Store Name` is one of the requested names exactly,
 * keyed by the trimmed name and the date.
 */
describe.skipIf(!connection)('daily store report on verified-schema local MySQL', () => {
  const schema = `pos_v2_reports_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    user: Principal = {
      id: '1',
      name: 'Fixture',
      email: 'fixture@example.test',
      role: 1,
      userType: 1,
      storeIds: ['1', '2', '3'],
    },
    clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    liveUrl = '',
    created = false;
  async function insert(table: string, row: Record<string, FixtureValue>) {
    await verifiedMysqlFixture(admin!).insert(table, row);
  }
  let hp = 0;
  async function order(
    id: number,
    createdAt: string,
    lines: Record<string, FixtureValue>[],
    extra: Record<string, FixtureValue> = {},
  ) {
    await insert('orders', {
      id,
      user_id: 1,
      order_status: 1,
      payment_status: 1,
      country_id: 'India',
      created_at: createdAt,
      pay_amt: 0,
      voucher_amt_used: 0,
      ...extra,
    });
    for (const line of lines)
      await insert('has_products', {
        id: ++hp,
        order_id: id,
        prod_id: 100,
        sub_prod_id: 0,
        qty: 1,
        price: 0,
        disc: 0,
        gst: 12,
        store_disc_pg: 0,
        pre_gst_amt: 0,
        wallet_disc: 0,
        hp_tss_points_used: 0,
        status: 'DELIVERED',
        ...line,
      });
  }
  async function walkIn(
    id: number,
    store: number,
    createdAt: string,
    lines: Record<string, FixtureValue>[],
    extra: Record<string, FixtureValue> = {},
    payment: Record<string, FixtureValue> = {},
  ) {
    await order(id, createdAt, lines, extra);
    await insert('order_stores', {
      id,
      order_id: id,
      store_id: store,
      offline_payment: 0,
      online_other_payment: 0,
      district_transaction_id: null,
      ...payment,
    });
  }
  async function online(
    id: number,
    store: number,
    createdAt: string,
    lines: Record<string, FixtureValue>[],
    extra: Record<string, FixtureValue> = {},
  ) {
    await order(id, createdAt, lines, extra);
    await insert('pos_online_orders', { id, order_id: id, store_id: store });
  }

  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Daily report fixtures require local MySQL.');
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
    await createProductionTables(admin, tables);
    for (const [id, name, code] of [
      [1, 'Store one', 'LOC-1'],
      [2, ' Store two ', 'LOC-2'],
      [3, 'Store three', 'LOC-3'],
    ] as const)
      await insert('stores', { id, store_name: name, location_code: code });
    for (const [id, email] of [
      [1, 'customer@example.test'],
      [2, 'schedular.tss@gmail.com'],
      [1604315, 'internal@example.test'],
    ] as const)
      await insert('users', { id, email });
    for (const [id, status] of [
      [1, 'Paid'],
      [2, 'Pending'],
      [3, 'Failed'],
      [4, 'Paid/Refunded'],
    ] as const)
      await insert('payment_status', { id, payment_status: status });
    for (const [id, parent] of [
      [100, 0],
      [101, 100],
      [147501, 0],
      [161509, 0],
      [162618, 0],
      [300, 0],
      [400, 0],
      [500, 0],
    ] as const)
      await insert('products', { id, product: `Fixture ${id}`, parent_prod_id: parent });
    for (const [id, name] of [
      [10, 'GIFTVOUCHER'],
      [20, 'Packaging Materials'],
      [30, 'Apparel'],
      [153, 'Preferred'],
      [162, 'Ignored'],
    ] as const)
      await insert('categories', { id, category: name });
    for (const [id, product, category] of [
      [1, 100, 30],
      [2, 300, 10],
      [3, 400, 162],
      [4, 400, 20],
      [5, 500, 10],
      [6, 500, 153],
      [7, 147501, 30],
      [8, 162618, 30],
      [9, 161509, 30],
    ] as const)
      await insert('has_categories', { id, prod_id: product, cat_id: category });

    // Store 1 walk-in: day bounds, membership purchase, district, exclusive, pre-GST branch.
    await walkIn(
      5001,
      1,
      '2026-11-16 00:00:00',
      [
        {
          sub_prod_id: 101,
          qty: 2,
          price: 1100,
          disc: 50.25,
          wallet_disc: 10.5,
          hp_tss_points_used: 5,
        },
        { prod_id: 162618, qty: 1, price: 0, gst: 0 },
      ],
      { pay_amt: 1049.5, voucher_amt_used: 50 },
      { offline_payment: 600, online_other_payment: 399.5, district_transaction_id: '' },
    );
    await walkIn(
      5002,
      1,
      '2026-11-16 12:30:00',
      [
        { prod_id: 147501, price: 699, gst: 18, store_disc_pg: 30.3, status: 'PROCESSING' },
        { sub_prod_id: 101, price: 499, status: 'RETURN_PLACED' },
      ],
      { payment_status: 2, pay_amt: 700, voucher_amt_used: null },
      { online_other_payment: 700, district_transaction_id: 'DIST-1' },
    );
    await insert('order_attributes', { id: 1, order_id: 5002 });
    await walkIn(
      18622460,
      1,
      '2026-11-16 23:59:59',
      [{ qty: 3, price: 999, gst: 5, pre_gst_amt: '951.43', status: 'SHIPPED' }],
      { payment_status: 4, pay_amt: 999 },
      { offline_payment: 333.33, online_other_payment: 665.67 },
    );
    await walkIn(
      5013,
      1,
      '2026-11-16 14:00:00',
      [
        { prod_id: 400, price: 20 },
        { prod_id: 500, price: 1299.99, disc: 0.01, store_disc_pg: 64.995, gst: 12 },
      ],
      { pay_amt: 1235 },
      { offline_payment: 1235 },
    );
    // Store 1 walk-in rows the source filters drop.
    const dropped: [number, string, Record<string, FixtureValue>, Record<string, FixtureValue>][] =
      [
        [5003, '2026-11-17 00:00:00', {}, {}],
        [5004, '2026-11-15 23:59:59', {}, {}],
        [5005, '2026-11-16 10:00:00', { order_status: 0 }, {}],
        [5006, '2026-11-16 10:00:00', { order_status: 17 }, {}],
        [5007, '2026-11-16 10:00:00', { payment_status: 3 }, {}],
        [5008, '2026-11-16 10:00:00', {}, {}],
        [5009, '2026-11-16 10:00:00', { user_id: 1604315 }, {}],
        [5010, '2026-11-16 10:00:00', { user_id: 2 }, {}],
        [5011, '2026-11-16 10:00:00', { country_id: 'Nepal' }, {}],
        [5012, '2026-11-16 10:00:00', {}, { prod_id: 300 }],
        [5014, '2026-11-16 10:00:00', { user_id: 99 }, {}],
      ];
    for (const [id, createdAt, extra, line] of dropped)
      await walkIn(
        id,
        1,
        createdAt,
        [{ price: 100, ...line }],
        { pay_amt: 100, ...extra },
        {
          offline_payment: 100,
        },
      );
    await insert('exchange_order_log', {
      id: 1,
      parent_order_id: 5001,
      parent_has_product_id: 1,
      order_id: 5008,
      has_product_id: 1,
      created_at: '2026-11-16 10:00:00',
      updated_at: '2026-11-16 10:00:00',
    });
    // Store 2 walk-in.
    await walkIn(
      6001,
      2,
      '2026-11-16 10:00:00',
      [{ price: 250, store_disc_pg: 12.5, hp_tss_points_used: 0.1 }],
      { pay_amt: 237.5 },
      { online_other_payment: 237.5 },
    );
    // Store-assisted online orders.
    await online(
      7001,
      1,
      '2026-11-16 09:00:00',
      [{ sub_prod_id: 101, qty: 2, price: 1598, disc: 100, hp_tss_points_used: 20 }],
      { pay_amt: 1478 },
    );
    await online(18622430, 1, '2026-11-16 11:00:00', [{ price: 560.28, pre_gst_amt: '500.25' }], {
      user_id: 99,
      pay_amt: 560.28,
    });
    await online(7002, 1, '2026-11-16 16:00:00', [{ prod_id: 161509, price: 299, gst: 18 }], {
      pay_amt: 299,
    });
    await insert('order_attributes', { id: 2, order_id: 7002 });
    await online(7003, 2, '2026-11-16 15:00:00', [{ price: 799 }], { pay_amt: 799 });
    await online(7004, 2, '2026-11-16 15:00:00', [{ price: 799 }], { user_id: 2, pay_amt: 799 });
    for (const [id, store, date, amount] of [
      [1, 1, '2026-11-16', '1234.56'],
      [2, 2, '2026-11-15', '99.00'],
      [3, 3, '2026-11-16', '10.00'],
    ] as const)
      await insert('store_day_banking', {
        id,
        store_id: store,
        banking_date: date,
        amount,
        updated_by_id: 1,
        created_at: '2026-11-16 20:00:00.000000',
        updated_at: '2026-11-16 20:00:00.000000',
      });
    url.pathname = '/' + schema;
    liveUrl = url.href;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'daily-store-report-mysql-'.repeat(3),
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

  const legacyResponse = z.object({
    data: z.array(z.record(z.string(), z.unknown())),
    totals: z.record(z.string(), z.unknown()),
  });
  function legacy(stores: string[]) {
    const input = JSON.stringify({
      url: liveUrl,
      selectedStores: stores,
      orderDateRange: '11/16/2026 - 11/16/2026',
      footfall,
      target,
    });
    return legacyResponse.parse(
      JSON.parse(
        goldenStdout(
          'reports',
          'daily-store-report-mysql',
          input,
          undefined,
          fixturePlaceholders(liveUrl),
        ),
      ) as unknown,
    );
  }
  const auxiliary = async (names: string[]) => {
    const wanted = new Set(names);
    const pick = (rows: [string, string, number][]) =>
      Object.fromEntries(
        rows
          .filter(([name]) => wanted.has(name))
          .map(([name, date, value]) => [`${name.trim()}\0${date}`, value]),
      );
    return { footfall: pick(footfall), target: pick(target) };
  };
  async function rewrite(stores: string[]) {
    const config = readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      SESSION_SECRET: 'daily-store-report-mysql-'.repeat(3),
    });
    return reportService(config, databases!, {
      clock,
      warehouse: {
        dailyRollups: () => Promise.reject(new Error('Today reads MySQL, not the warehouse.')),
        auxiliary,
      },
    }).daily(user, { storeIds: stores, from: '2026-11-16', to: '2026-11-16' });
  }

  it.each([[['1', '2', '3']], [['2']]])(
    'returns the pinned source rows and footer for stores %j',
    async (stores) => {
      const expected = legacy(stores),
        actual = await rewrite(stores);
      expect(actual.reader).toBe('data');
      expect(actual.data.length).toBeGreaterThan(0);
      expect(actual.data).toEqual(expected.data);
      expect(actual.totals).toEqual(expected.totals);
    },
  );
});
