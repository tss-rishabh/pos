import { randomUUID } from 'node:crypto';
import { goldenStdout } from '../golden/load.js';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import {
  flashSalesInputSchema,
  flashSalesOptions,
  flashSalesReportService,
  flashSalesSourceRowSchema,
  flashRefundRowSchema,
  prepareFlashSales,
} from '../../src/modules/operational-reports/flash-sales.js';

/** Replays the pinned CPython 3.10 source oracles captured for this test (tests/golden). */
function executePosSourceOracle(args: readonly string[], options: { input?: string }): string {
  return goldenStdout('operational-reports', 'flash-sales-mysql-integration', options.input, [
    '-B',
    ...args,
  ]);
}
const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('flash-sales source SQL on verified-schema local MySQL', () => {
  const schema = `pos_rewrite_flash_sales_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    config = readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      SESSION_SECRET: 'flash-report-mysql-'.repeat(4),
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
      throw new Error('Flash fixture requires local MySQL.');
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
      'order_stores',
      'has_products',
      'stores',
      'pos_paytm_transactions',
      'return_orders',
      'amount_to_be_refunded_log',
      'automated_refund_sic_logs',
    ]);
    await fixture.insert('stores', { id: 1, store_name: 'Fixture one' });
    await fixture.insert('stores', { id: 2, store_name: 'Fixture two' });
    for (const [id, status, createdAt, store] of [
      [1001, 3, '2026-11-16 10:00:00', 1],
      [1002, 0, '2026-11-16 10:00:00', 1],
      [1003, 3, '2026-11-15 10:00:00', 1],
      [1004, 3, '2026-11-16 10:00:00', 2],
    ] as const) {
      await fixture.insert('orders', {
        id,
        created_at: createdAt,
        order_status: status,
        tss_money_used: 2.675,
        tss_points_used: 1.005,
        coupon_amt_used: 0,
        voucher_amt_used: 3,
        pg_disc: 4,
      });
      await fixture.insert('order_stores', {
        id: id - 1000,
        order_id: id,
        store_id: store,
        offline_payment: id === 1001 ? 100.5 : 900,
        online_payment: 10,
        online_other_payment: 7,
        district_transaction_id: 'FIXTURE-DISTRICT',
        credit_pincode_id: 'FIXTURE-PINCODE',
      });
      await fixture.insert('has_products', {
        id: id - 500,
        order_id: id,
        prod_id: 101,
        qty: 9,
        return_mode: id === 1001 ? 3 : 0,
        status: 'PRODUCT_RETURNED',
      });
    }
    await fixture.insert('has_products', {
      id: 1502,
      order_id: 1001,
      prod_id: 102,
      qty: 20,
      return_mode: 2,
      status: 'PRODUCT_RETURNED',
    });
    await fixture.insert('order_stores', {
      id: 99,
      order_id: 1001,
      store_id: 2,
      offline_payment: 20,
      online_other_payment: 0,
    });
    for (const [id, mode, amount, store] of [
      [1, 1003, 10, 1],
      [2, 1003, 11, 1],
      [3, 1004, 1, 1],
      [4, 1004, 2, 1],
      [5, 1004, 99, 2],
    ] as const)
      await fixture.insert('pos_paytm_transactions', {
        id,
        order_id: 1001,
        store_id: store,
        payment_mode: mode,
        amount,
        platform: 'txn_completed',
        is_active: 1,
      });
    for (const [id, time] of [
      [1, '2026-11-16 00:00:00'],
      [2, '2026-11-16 23:59:59'],
    ] as const)
      await fixture.insert('return_orders', {
        id,
        order_id: 1001,
        prod_id: 101,
        has_product_id: 501,
        store_id: 2,
        qty: 1,
        created_at: time,
      });
    await fixture.insert('amount_to_be_refunded_log', {
      id: 1,
      order_id: 1001,
      prod_id: 101,
      has_product_id: 501,
      refunded_amt: 10,
      refund_mode: 'CASH',
    });
    await fixture.insert('amount_to_be_refunded_log', {
      id: 2,
      order_id: 1001,
      prod_id: 101,
      has_product_id: 501,
      refunded_amt: 2.675,
      refund_mode: 'TSS_MONEY',
    });
    await fixture.insert('amount_to_be_refunded_log', {
      id: 3,
      order_id: 1001,
      prod_id: 101,
      has_product_id: 501,
      refunded_amt: -5,
      refund_mode: 'CASH',
    });
    await fixture.insert('automated_refund_sic_logs', {
      order_id: 1001,
      product_id: 102,
      platform: 'OG',
      refunded_amount: 4.125,
      refunded_at: '2026-11-16 11:00:00',
    });
    await fixture.insert('automated_refund_sic_logs', {
      order_id: 1001,
      product_id: 102,
      platform: 'TSS_MONEY',
      refunded_amount: 99,
      refunded_at: '2026-11-15 23:59:59',
    });
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'flash-report-config-'.repeat(3),
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
  it('preserves original screen/export multiplicity, order-wide cash and source refund attribution', async () => {
    if (!databases) throw new Error('Fixture unavailable.');
    const input = flashSalesInputSchema.parse({
        from: '2026-11-16',
        to: '2026-11-16',
        storeIds: ['1'],
      }),
      [mode] = await admin!.query<mysql.RowDataPacket[]>('SELECT @@SESSION.sql_mode AS value'),
      original = String(mode[0]?.value || '');
    const source = async (kind: 'interactive' | 'export' | 'refunds') => {
      const query = executePosSourceOracle(
        [
          'tools/operational-reports/flash-sales-query-oracle.py',
          kind,
          '2026-11-16 00:00:00',
          '2026-11-16 23:59:59',
          '1',
        ],
        { encoding: 'utf8' },
      );
      try {
        await admin!.query('SET SESSION sql_mode=?', [
          original
            .split(',')
            .filter((value) => value !== 'ONLY_FULL_GROUP_BY')
            .join(','),
        ]);
        return (await admin!.query<mysql.RowDataPacket[]>(query))[0];
      } catch {
        throw new Error('Original flash fixture query failed.');
      } finally {
        await admin!.query('SET SESSION sql_mode=?', [original]);
      }
    };
    const refunds = z.array(flashRefundRowSchema).parse(await source('refunds'));
    const service = flashSalesReportService(
      config,
      databases,
      flashSalesOptions(
        Object.fromEntries(
          [
            'ORDERS',
            'ORDER_STORES',
            'LINES',
            'STORES',
            'PAYTM_TRANSACTIONS',
            'RETURN_ORDERS',
            'REFUND_LOGS',
            'AUTOMATED_REFUNDS',
          ].map((key) => [
            'BQ_FLASH_SALES_' + key + '_VIEW',
            'fixture-project.reports.' + key.toLowerCase(),
          ]),
        ),
      ),
      {
        async queryReport(statement, params) {
          // Independent literal source SQL above supplies the fixture projection.
          expect(statement).toContain('refunded_at');
          expect(params).toEqual({
            start: '2026-11-16 00:00:00',
            end: '2026-11-16 23:59:59',
            stores: ['1'],
          });
          return refunds;
        },
      },
      clock,
    );
    for (const kind of ['interactive', 'export'] as const) {
      const expected = prepareFlashSales(
          z.array(flashSalesSourceRowSchema).parse(await source(kind)),
          refunds,
        ),
        result = await service.read(user, input, kind === 'export');
      expect(result.data).toEqual(expected);
      expect(result.reader).toBe('data');
      expect(result.data[0]).toMatchObject({
        cash: 120.5,
        total_paytm_card_amount: 21,
        total_paytm_upi_amount: 3,
        cash_return: 20,
        tss_money_return: 5.35,
        other_online_return: 4.12,
        total_number_of_qty_sold: kind === 'interactive' ? 12 : 2,
        district_transation_amt: kind === 'interactive' ? 84 : 14,
      });
    }
    expect((await service.read(user, { ...input, page: 999 })).page).toBe(1);
    expect((await service.read({ ...user, userType: 2 }, { ...input, storeIds: [] })).total).toBe(
      1,
    );
  });
});
