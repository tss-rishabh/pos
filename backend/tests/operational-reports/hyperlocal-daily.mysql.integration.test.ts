import { randomUUID } from 'node:crypto';
import { goldenStdout } from '../golden/load.js';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  hyperlocalDailyInputSchema,
  hyperlocalDailyOptions,
  hyperlocalDailyReportService,
} from '../../src/modules/operational-reports/hyperlocal-daily.js';

/** Replays the pinned CPython 3.10 source oracles captured for this test (tests/golden). */
function executePosSourceOracle(args: readonly string[], options: { input?: string }): string {
  return goldenStdout('operational-reports', 'hyperlocal-daily-mysql-integration', options.input, [
    '-B',
    ...args,
  ]);
}
const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('source hyperlocal daily SQL on verified-schema local MySQL', () => {
  const schema = `pos_rewrite_hyperlocal_daily_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    config = readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      SESSION_SECRET: 'daily-report-mysql-'.repeat(4),
    }),
    user: Principal = {
      id: '10',
      name: 'Fixture',
      email: 'fixture@example.test',
      role: 4,
      userType: 1,
      storeIds: ['1'],
    },
    clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Daily fixture requires local MySQL.');
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
    const fixture = verifiedMysqlFixture(admin);
    await fixture.create([
      'orders',
      'has_products',
      'express_line_item',
      'stores',
      'order_status',
      'express_order_status_log',
    ]);
    await fixture.insert('stores', { id: 1, store_name: 'Fixture one', location_code: 'FIX-1' });
    await fixture.insert('stores', { id: 2, store_name: 'Fixture two', location_code: 'FIX-2' });
    await fixture.insert('order_status', { id: 3, display_name: 'Fixture delivered' });
    for (const [id, store, expires] of [
      [1001, 1, '2026-11-16 00:00:00'],
      [1002, 1, '2026-11-16 23:59:59'],
      [1003, 2, '2026-11-16 11:00:00'],
      [1004, 1, '2026-11-15 23:59:59'],
    ] as const) {
      await fixture.insert('orders', {
        id,
        user_id: 1,
        first_name: 'Fixture',
        last_name: 'Customer',
        created_at: '2026-11-15 10:00:00',
        order_status: 3,
      });
      await fixture.insert('has_products', {
        id: id - 1000,
        order_id: id,
        prod_id: 22,
        qty: 2,
        pre_gst_amt: 100,
        gst: 18,
        status: 'DELIVERED',
      });
      await fixture.insert('express_line_item', {
        order_id: id,
        has_product_id: id - 1000,
        store_id: store,
        pending_expires_at: expires,
        status: 'PACKED',
      });
    }
    // Production express_line_item has UNIQUE KEY unique_order_product(order_id,has_product_id),
    // so one line can never carry repeated or differently-statused ELI rows.
    for (const [status, time] of [
      ['ACCEPTED', '2026-11-14 10:00:00'],
      ['ACCEPTED', '2026-11-15 10:00:00'],
      ['PACKED', '2026-11-16 11:00:00'],
      ['OUT_FOR_DELIVERY', '2026-11-16 12:00:00'],
      ['DELIVERED', '2026-11-16 13:00:00'],
    ] as const)
      await fixture.insert('express_order_status_log', {
        order_id: 1001,
        store_id: 1,
        old_status: 'PENDING',
        new_status: status,
        changed_at: time,
      });
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'daily-report-config-'.repeat(3),
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
  it('preserves actual source grouping, expiry inclusivity and all-history earliest lifecycle timestamps', async () => {
    if (!databases) throw new Error('Fixture unavailable.');
    const input = hyperlocalDailyInputSchema.parse({
        from: '2026-11-16T00:00:00',
        to: '2026-11-16T23:59:59',
      }),
      query = executePosSourceOracle(
        [
          'tools/operational-reports/hyperlocal-daily-oracle.py',
          '2026-11-16 00:00:00',
          '2026-11-16 23:59:59',
          '1',
        ],
        { encoding: 'utf8' },
      ),
      [rows] = await admin!.query<mysql.RowDataPacket[]>(query);
    const service = hyperlocalDailyReportService(
      config,
      databases,
      hyperlocalDailyOptions({
        BQ_HYPERLOCAL_DAILY_VIEW: 'fixture-project.reports.hyperlocal',
      }),
      {
        async queryReport(statement, params) {
          // Native original SELECT is the isolated compatible-view oracle,
          // including all-history lifecycle MINs.
          const sourceQuery = executePosSourceOracle(
            [
              'tools/operational-reports/hyperlocal-daily-oracle.py',
              String(params.start),
              String(params.end),
              params.allStores === true ? '1,2' : (params.stores as string[]).join(','),
            ],
            { encoding: 'utf8' },
          );
          const [projected] = await admin!.query<mysql.RowDataPacket[]>(sourceQuery);
          return statement.startsWith('SELECT COUNT(')
            ? [{ count: projected.length }]
            : projected.slice(Number(params.offset), Number(params.offset) + Number(params.limit));
        },
      },
      clock,
    );
    const result = await service.read(user, input);
    const normalized = rows.map((row) => ({
        ...row,
        order_id: String(row.order_id),
        user_id: String(row.user_id),
        line_item_id: String(row.line_item_id),
        sku_id: String(row.sku_id),
        qty: Number(row.qty),
        amount: Number(row.amount),
        express_line_item_status:
          row.express_line_item_status === null ? null : String(row.express_line_item_status),
      })),
      key = (value: { line_item_id: string; express_line_item_status: string | null }) =>
        `${value.line_item_id}:${value.express_line_item_status}`;
    expect(result.total).toBe(2);
    expect(result.reader).toBe('bigquery');
    expect([...result.data].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      normalized.sort((a, b) => key(a).localeCompare(key(b))),
    );
    expect(
      result.data.find(
        (row) => row.line_item_id === '1' && row.express_line_item_status === 'PACKED',
      ),
    ).toMatchObject({
      qty: 2,
      amount: 118,
      allocation_date: '2026-11-14 10:00:00',
      delivery_date: '2026-11-16 13:00:00',
    });
    expect((await service.read(user, { ...input, page: 999, pageSize: 1 })).page).toBe(1);
    expect((await service.read({ ...user, role: 1 }, input)).total).toBe(3);
    expect((await service.read({ ...user, role: 1, userType: 2 }, input)).total).toBe(2);
  });
});
