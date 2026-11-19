import mysql from 'mysql2/promise';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { and, eq, inArray } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { goldenStdout } from '../golden/load.js';
import { createProductionTables } from '../helpers/production-schema.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as models from '../../src/db/legacy-schema.js';
import { ProductStore } from '../../src/db/legacy-schema.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { readConfig } from '../../src/config.js';
import type { Principal } from '../../src/domain/access.js';
import {
  customerFeedbackService,
  feedbackOptions,
} from '../../src/modules/operational-reports/feedback.js';
import { inventoryAssociationService } from '../../src/modules/operational-reports/inventory.js';
import {
  acceptanceReportService,
  acceptanceOptions,
  acceptanceInputSchema,
} from '../../src/modules/operational-reports/acceptance.js';
import {
  staffPerformanceService,
  performanceOptions,
  salespersonInputSchema,
  cashierInputSchema,
} from '../../src/modules/operational-reports/performance.js';
import { scalarId } from '../../src/modules/operational-reports/report-inputs.js';
import { reportExportBuilder } from '../../src/modules/operational-reports/export-service.js';
import {
  returnedOrdersReportService,
  returnedOrdersInputSchema,
  returnedOrdersOptions,
  returnedOrdersCsv,
} from '../../src/modules/operational-reports/returned-orders.js';

/** Replays the pinned CPython 3.10 source oracles captured for this test (tests/golden). */
function executePosSourceOracle(args: readonly string[], options: { input?: string }): string {
  return goldenStdout('operational-reports', 'mysql-integration', options.input, ['-B', ...args]);
}

const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('operational reports on isolated local MySQL', () => {
  const schema = `pos_rewrite_ops_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
    tables = new Map(Object.values(models).map((model) => [getTableConfig(model).name, model]));
  const user: Principal = {
      id: '900001',
      name: 'Fixture operator',
      email: 'operator@example.test',
      role: 4,
      userType: 1,
      storeIds: ['1'],
    },
    clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
    config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'operational-reports-fixture-'.repeat(3),
    });
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  function db() {
    if (!databases) throw new Error('Fixture not initialized');
    return databases;
  }
  async function insert(name: string, overrides: Record<string, string | number | null>) {
    const model = tables.get(name);
    if (!model) throw new Error('Fixture model missing.');
    const cfg = getTableConfig(model),
      known = new Set(cfg.columns.map((column) => column.name));
    if (Object.keys(overrides).some((key) => !known.has(key)))
      throw new Error('Fixture overrides contain an unmapped column.');
    const columns = cfg.columns.filter(
        (column) =>
          !('autoIncrement' in column && column.autoIncrement && !(column.name in overrides)),
      ),
      values = columns.map((column) => {
        if (column.name in overrides) return overrides[column.name];
        if (!column.notNull) return null;
        const type = column.getSQLType().toLowerCase();
        if (type.startsWith('datetime') || type.startsWith('timestamp'))
          return '2026-11-16 12:00:00';
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
      throw new Error('Operational fixtures require local MySQL.');
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
    // Production DDL already carries order_stores.salesperson_id/admin_user_id,
    // tss_money_history.has_product_id, product_store.uq_product_store and the NPS tables.
    await createProductionTables(admin, [
      'products',
      'product_store',
      'stores',
      'orders',
      'order_stores',
      'users',
      'pos_user',
      'user_stores',
      'hyperlocal_order_log',
      'has_products',
      'salespersons',
      'return_orders',
      'amount_to_be_refunded_log',
      'reverse_pickup_reason',
      'sub_reasons',
      'tss_money_history',
      'nps_feedback',
      'nps_questions',
    ]);
    await insert('stores', {
      id: 1,
      store_name: 'Fixture one',
      phone: '9000000001',
      type: 'STORE',
      is_active: 1,
    });
    await insert('stores', {
      id: 2,
      store_name: 'Fixture two',
      phone: '9000000002',
      type: 'STORE',
      is_active: 1,
    });
    await insert('pos_user', {
      id: 900001,
      username: 'fixture-operator',
      first_name: 'Fixture',
      last_name: 'Operator',
      role: 4,
      is_active: 1,
      user_type: 1,
    });
    await insert('user_stores', { id: 1, django_user_id: 900001, store_id: 1 });
    await insert('pos_user', {
      id: 900002,
      username: 'second-operator',
      first_name: 'Another',
      last_name: 'Operator',
      role: 4,
      user_type: 1,
      is_active: 1,
    });
    for (const id of [1, 2, 3])
      await insert('users', {
        id,
        firstname: 'Fixture',
        lastname: 'Customer',
        email: id === 1 ? 'fixture@example.test' : `customer${id}@example.test`,
        telephone: '+91 12345 67890',
      });
    for (const [id, customer, date] of [
      [1001, 1, '2026-11-16 10:00:00'],
      [1002, 2, '2026-11-16 11:00:00'],
      [1003, 3, '2026-11-16 12:00:00'],
      [1004, 1, '2026-11-15 10:00:00'],
    ] as const) {
      await insert('orders', { id, user_id: customer, created_at: date });
      if (id !== 1003)
        await insert('order_stores', {
          id: id - 1000,
          order_id: id,
          store_id: id === 1002 ? 2 : 1,
          counter_id: 1,
        });
    }
    await admin.query(
      "INSERT INTO nps_questions(id,question) VALUES(1,'Recommend this store?'),(2,'What worked well?')",
    );
    await admin.query(
      "INSERT INTO nps_feedback(order_id,question_id,feedback_answer,created_at) VALUES(1001,1,'9','2026-11-16 12:00:00'),(1001,2,'Fixture feedback','2026-11-16 12:01:00'),(1002,1,'2','2026-11-16 12:00:00'),(1003,1,'7','2026-11-16 12:00:00'),(1004,1,'5','2026-11-16 12:00:00')",
    );
    await admin.query('UPDATE orders SET location_id=CASE WHEN id=1002 THEN 2 ELSE 1 END');
    for (const [id, order, staff, createdAt, updatedAt, action] of [
      [1, 1001, 900001, '2026-11-16 00:00:00', '2026-11-16 00:01:02', 'ACCEPTED'],
      [2, 1001, 900002, '2026-11-16 11:00:00', '2026-11-18 11:00:01', 'accepted'],
      [3, 1002, 0, '2026-11-16 10:00:00', '2026-11-16 10:00:05', 'ACCEPTED'],
      [4, 1001, 0, '2026-11-15 23:59:59', '2026-11-16 00:00:00', 'ACCEPTED'],
      [5, 1001, 0, '2026-11-16 23:59:59', '2026-11-17 00:00:00', 'ACCEPTED'],
      [6, 1001, 0, '2026-11-17 00:00:00', '2026-11-17 00:00:01', 'ACCEPTED'],
      [7, 1001, 0, '2026-11-16 10:00:00', '2026-11-16 10:00:01', 'DECLINED'],
      [8, 999999, 0, '2026-11-16 09:00:00', '2026-11-16 09:00:01', 'ACCEPTED'],
      [9, 1001, 0, '2026-11-16 08:00:00', '2026-11-16 07:59:59', 'ACCEPTED'],
    ] as const)
      await insert('hyperlocal_order_log', {
        id,
        order_id: order,
        pos_admin_id: staff,
        created_at: createdAt,
        updated_at: updatedAt,
        action,
      });
    for (const id of [100, 200, 300, 400, 500, 600])
      await insert('products', {
        id,
        product: `Fixture parent ${id}`,
        prod_type: 3,
        parent_prod_id: 0,
      });
    for (const [id, parent, type] of [
      [101, 100, 1],
      [102, 100, 1],
      [201, 200, 1],
      [301, 300, 1],
      [401, 400, 2],
      [501, 500, 1],
      [601, 600, 1],
    ] as const) {
      await insert('products', {
        id,
        product: `Fixture variant ${id}`,
        parent_prod_id: parent,
        prod_type: type,
      });
      await insert('product_store', {
        product_id: id,
        store_id: id === 301 ? 2 : 1,
        stock: 7,
        is_avail: 0,
        is_del: 1,
      });
    }
    await insert('product_store', {
      product_id: 200,
      store_id: 1,
      stock: 12,
      is_avail: 0,
      is_del: 1,
    });
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'operational-mysql-fixture-'.repeat(3),
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_WRITER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  });
  it('matches the original return report SELECT including exchange credit and duplicate refund joins', async () => {
    await insert('orders', { id: 6100, parent_order_id: 6200, created_at: '2026-11-16 09:00:00' });
    await insert('reverse_pickup_reason', { id: 1, reason: 'Fit', type: 3 });
    await insert('sub_reasons', { id: 1, reason: 1, sub_reason: 'Too large' });
    for (const [id, mode, status] of [
      [601, 3, 'RETURNED'],
      [602, 5, 'EXCHANGE_COMPLETED'],
      [603, 5, 'DELIVERED'],
      [604, 3, 'RETURNED'],
      [605, 3, 'RETURNED'],
    ] as const) {
      await insert('has_products', {
        id,
        order_id: 6100,
        prod_id: 100,
        qty: 2,
        return_mode: mode,
        status,
        created_at: '2026-11-14 10:00:00',
      });
      await insert('return_orders', {
        id: 6100 + id,
        order_id: 6100,
        prod_id: 100,
        has_product_id: id,
        qty: 1,
        store_id: id === 605 ? 2 : 1,
        reason_id: 1,
        sub_reason_id: 1,
        comment: id === 602 ? '=SUM(A1:A2)' : "Fit ' quote",
        created_at: id === 604 ? '2026-11-15 10:00:00' : '2026-11-16 10:00:00',
      });
    }
    await insert('return_orders', {
      id: 7000,
      order_id: 6100,
      prod_id: 100,
      has_product_id: 601,
      qty: 1,
      store_id: 1,
      reason_id: 1,
      sub_reason_id: 1,
      comment: "Fit ' quote",
      created_at: '2026-11-16 10:00:00',
    });
    for (const [id, line, amount, mode] of [
      [6001, 601, 10, 'cash'],
      [6002, 601, 20, 'cash'],
      [6003, 602, 999, 'card'],
    ] as const)
      await insert('amount_to_be_refunded_log', {
        id,
        order_id: 6100,
        prod_id: 100,
        has_product_id: line,
        refunded_amt: amount,
        refund_mode: mode,
        is_refunded: 1,
      });
    for (const [id, amount] of [
      [6001, 25],
      [6002, 15],
    ] as const) {
      await insert('tss_money_history', {
        id,
        order_id: 6100,
        platform: 'EXCHANGE',
        added_amt: amount,
      });
      await admin!.query('UPDATE tss_money_history SET has_product_id=602 WHERE id=?', [id]);
    }
    const input = returnedOrdersInputSchema.parse({
        from: '2026-11-16T00:00:00',
        to: '2026-11-16T23:59:59',
        storeIds: ['1'],
      }),
      query = executePosSourceOracle(
        [
          'tools/operational-reports/returned-orders-oracle.py',
          '2026-11-16 00:00:00',
          '2026-11-16 23:59:59',
          '1',
        ],
        { encoding: 'utf8' },
      ),
      [mode] = await admin!.query<mysql.RowDataPacket[]>('SELECT @@SESSION.sql_mode AS value'),
      original = String(mode[0]?.value || '');
    let expected: mysql.RowDataPacket[] = [];
    try {
      await admin!.query('SET SESSION sql_mode=?', [
        original
          .split(',')
          .filter((value) => value !== 'ONLY_FULL_GROUP_BY')
          .join(','),
      ]);
      [expected] = await admin!.query<mysql.RowDataPacket[]>(query);
    } finally {
      await admin!.query('SET SESSION sql_mode=?', [original]);
    }
    const service = returnedOrdersReportService(
      config,
      db(),
      returnedOrdersOptions({
        BQ_RETURNED_ORDERS_VIEW: 'fixture-project.reports.returns',
      }),
      {
        async queryReport(statement, params) {
          // Execute the literal pinned source on this disposable fixture as the
          // compatible-view oracle. The application never receives a MySQL port
          // for old facts; this does not certify a live warehouse publication.
          const projectedQuery = query.replace('hp.id,', 'hp.id,ANY_VALUE(ro.id) AS return_id,');
          const search = String(params.search);
          const cells = [
            'store_name',
            'order_id',
            'prod_id',
            'qty',
            'reason',
            'sub_reason',
            'comment',
            'created_at',
          ];
          let projected: mysql.RowDataPacket[];
          try {
            await admin!.query('SET SESSION sql_mode=?', [
              original
                .split(',')
                .filter((part) => part !== 'ONLY_FULL_GROUP_BY')
                .join(','),
            ]);
            [projected] = await admin!.query<mysql.RowDataPacket[]>(
              `SELECT * FROM (${projectedQuery}) source_rows WHERE (?='' OR ${cells.map((cell) => `CAST(${cell} AS CHAR) LIKE ?`).join(' OR ')})`,
              [
                search,
                ...cells.map(() => '%' + search.replace(/[\\%_]/g, (part) => '\\' + part) + '%'),
              ],
            );
          } finally {
            await admin!.query('SET SESSION sql_mode=?', [original]);
          }
          if (statement.startsWith('SELECT COUNT(')) return [{ count: projected.length }];
          return projected
            .slice(Number(params.offset), Number(params.offset) + Number(params.limit))
            .map((row) => ({
              ...row,
              original_order_id: row.OriginalOrderId,
            }));
        },
      },
      clock,
    );
    const result = await service.read(user, input);
    const artifact = await reportExportBuilder(config, db(), { returnedOrders: service })(user, {
      kind: 'returned-orders',
      from: input.from,
      to: input.to,
      storeIds: input.storeIds,
    });
    expect(artifact.rowCount).toBe(2);
    expect(artifact.bytes.toString('utf8')).toBe(
      returnedOrdersCsv((await service.read(user, input, true)).data),
    );
    expect(result.total).toBe(2);
    expect(result.reader).toBe('bigquery');
    expect(
      result.data.map((row) => ({
        id: row.id,
        order: row.order_id,
        product: row.prod_id,
        quantity: row.qty,
        amount: row.pay_amount_refunded,
        mode: row.pay_amount_refunded_mode,
        reason: row.reason,
        subReason: row.sub_reason,
        comment: row.comment,
        date: row.created_at,
        original: row.original_order_id,
      })),
    ).toEqual(
      expected.map((row) => ({
        id: String(row.id),
        order: String(row.order_id),
        product: String(row.prod_id),
        quantity: row.qty,
        amount: row.pay_amount_refunded,
        mode: row.pay_amount_refunded_mode || null,
        reason: row.reason,
        subReason: row.sub_reason,
        comment: row.comment,
        date: row.created_at,
        original: String(row.OriginalOrderId),
      })),
    );
    expect(result.data.find((row) => row.id === '602')).toMatchObject({
      pay_amount_refunded: 25,
      pay_amount_refunded_mode: 'TSS_MONEY',
    });
    expect(result.data.find((row) => row.id === '601')?.pay_amount_refunded).toBe(20);
    expect(returnedOrdersCsv(result.data)).toContain("'=SUM(A1:A2)");
    expect((await service.read(user, { ...input, search: "Fit ' quote" })).total).toBe(1);
    expect((await service.read(user, { ...input, search: "' OR 1=1 --" })).total).toBe(0);
    expect((await service.read(user, { ...input, storeIds: [] })).total).toBe(0);
  });
  afterAll(async () => {
    await databases?.close();
    if (admin && created) {
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await admin?.end();
  });
  it('matches source performance SELECTs under strict MySQL grouping and actual Python cashier scoring', async () => {
    for (const id of [11, 12, 13])
      await insert('salespersons', {
        id,
        employee_id: id === 13 ? '' : `EMP-${id}`,
        first_name: 'Fixture',
        last_name: `Sales ${id}`,
      });
    for (const id of [41, 42])
      await insert('users', { id, firstname: 'Fixture', lastname: `Cashier ${id}` });
    for (const [id, date, store, salesperson, cashier, performance] of [
      [
        5001,
        '2026-11-16 10:00:00',
        1,
        11,
        41,
        { overall_performance_time: '1005', add_to_cart: '5' },
      ],
      [5002, '2026-11-16 11:00:00', 1, 11, 42, {}],
      [
        5003,
        '2026-11-15 10:00:00',
        1,
        12,
        41,
        { overall_performance_time: '2005', add_to_cart: '5' },
      ],
      [
        5004,
        '2026-11-16 12:00:00',
        2,
        12,
        42,
        { overall_performance_time: '5005', add_to_cart: '5' },
      ],
    ] as const) {
      await insert('orders', { id, created_at: date });
      await insert('order_stores', {
        order_id: id,
        store_id: store,
        counter_id: 1,
        performance_json: JSON.stringify(performance),
      });
      await admin!.query(
        'UPDATE order_stores SET salesperson_id=?,admin_user_id=? WHERE order_id=?',
        [salesperson, cashier, id],
      );
    }
    for (const [id, order, salesperson, price, quantity, status, createdAt] of [
      [501, 5001, 0, 100, 2, 'DELIVERED', '2026-11-16 10:00:00'],
      [502, 5001, 12, 200, 3, 'DELIVERED', '2026-11-16 10:00:00'],
      [503, 5002, 12, 50, 4, 'CANCELLED', '2026-11-16 11:00:00'],
      [504, 5003, 0, 40, 1, 'DELIVERED', '2026-11-16 09:00:00'],
      [505, 5004, 0, 999, 1, 'DELIVERED', '2026-11-16 12:00:00'],
      [506, 5001, 0, 1000, 1, 'DELIVERED', '2026-11-15 12:00:00'],
      [507, 5002, 13, 0, 0, 'DELIVERED', '2026-11-16 11:00:00'],
    ] as const)
      await insert('has_products', {
        id,
        order_id: order,
        prod_id: 100,
        salesperson_id: salesperson,
        price,
        qty: quantity,
        status,
        created_at: createdAt,
      });
    const input = { from: '2026-11-16T00:00:00', to: '2026-11-16T23:59:59', storeIds: ['1'] },
      reports = staffPerformanceService(config, db(), performanceOptions({}), undefined, clock),
      [people, cashiers] = await Promise.all([
        reports.salespeople({ ...user, role: 1 }, salespersonInputSchema.parse(input)),
        reports.cashiers({ ...user, role: 1 }, cashierInputSchema.parse(input)),
      ]);
    const sqlFor = (kind: string) =>
        executePosSourceOracle(
          [
            'tools/operational-reports/performance-query-oracle.py',
            kind,
            '2026-11-16 00:00:00',
            '2026-11-16 23:59:59',
            '1',
          ],
          { encoding: 'utf8' },
        ),
      [mode] = await admin!.query<mysql.RowDataPacket[]>('SELECT @@SESSION.sql_mode AS value'),
      original = String(mode[0]?.value || '');
    let sourcePeople: mysql.RowDataPacket[] = [],
      sourceCashiers: mysql.RowDataPacket[] = [];
    try {
      await admin!.query('SET SESSION sql_mode=?', [
        original
          .split(',')
          .filter((value) => value !== 'ONLY_FULL_GROUP_BY')
          .join(','),
      ]);
      [sourcePeople] = await admin!.query<mysql.RowDataPacket[]>(sqlFor('salesperson'));
      [sourceCashiers] = await admin!.query<mysql.RowDataPacket[]>(sqlFor('cashier'));
    } finally {
      await admin!.query('SET SESSION sql_mode=?', [original]);
    }
    expect(people.reader).toBe('data');
    expect(people.data.map((row) => [row.id, row.total_sales])).toEqual(
      sourcePeople.map((row) => [row.employee_id, row.total_sales]),
    );
    expect(people.data.map((row) => row.rating)).toEqual([10, 4.2]);
    const records = z
        .array(
          z.object({
            oi: scalarId,
            pos_admin_id: scalarId,
            cashier_name: z.string(),
            performance_json: z.string(),
            qty: z.union([z.string(), z.number()]),
          }),
        )
        .parse(sourceCashiers),
      expected: unknown = JSON.parse(
        executePosSourceOracle(['tools/operational-reports/performance-oracle.py'], {
          input: JSON.stringify({
            cases: [
              {
                kind: 'cashier',
                rows: records.map((row) => ({
                  orderId: row.oi,
                  cashierId: row.pos_admin_id,
                  cashierName: row.cashier_name,
                  performanceJson: row.performance_json,
                  quantity: Number(row.qty),
                })),
                sort: 'rating',
                direction: 'desc',
              },
            ],
          }),
          encoding: 'utf8',
        }),
      );
    expect(cashiers.reader).toBe('data');
    expect(cashiers.data).toEqual(z.array(z.unknown()).parse(expected)[0]);
    expect(cashiers.data.map((row) => row.product_sold).sort()).toEqual([4, 6]);
    await expect(reports.cashiers(user, cashierInputSchema.parse(input))).rejects.toMatchObject({
      code: 'ROLE_ACCESS_DENIED',
    });
  });
  it('matches source acceptance SELECT durations, inclusive boundaries and repeated log rows without staff N+1 reads', async () => {
    const report = acceptanceReportService(config, db(), acceptanceOptions({}), undefined, clock),
      input = acceptanceInputSchema.parse({
        from: '2026-11-16T00:00:00',
        to: '2026-11-16T23:59:59',
        storeIds: ['1'],
        sort: 'order_id',
        direction: 'asc',
        pageSize: 25,
      }),
      result = await report.read({ ...user, role: 1 }, input);
    const sourceSql = executePosSourceOracle(
        [
          'tools/operational-reports/acceptance-oracle.py',
          '2026-11-16 00:00:00',
          '2026-11-16 23:59:59',
          '1',
        ],
        { encoding: 'utf8' },
      ),
      [expected] = await admin!.query<mysql.RowDataPacket[]>(sourceSql);
    expect(result.reader).toBe('data');
    expect(result.total).toBe(4);
    expect(result.data.map((row) => [row.id, row.time_taken])).toEqual(
      expected.map((row) => [String(row.id), row.time_taken]),
    );
    expect(result.data[0]).toMatchObject({
      order_id: '1001',
      staff_name: 'Fixture Operator',
      created_at: '11/16/2026 12:00 AM',
      time_taken: '0H 1M 2S',
    });
    expect(result.data[1]).toMatchObject({
      staff_name: 'Another Operator',
      time_taken: '2D 0H 0M 1S',
    });
    expect(result.data[2]?.staff_name).toBe(0);
    expect(result.data.filter((row) => row.order_id === '1001')).toHaveLength(4);
    expect((await report.read({ ...user, role: 1 }, { ...input, page: 100 })).page).toBe(1);
    await expect(report.read(user, input)).rejects.toMatchObject({ code: 'ROLE_ACCESS_DENIED' });
  });
  it('keeps feedback scoped, masks restricted users and binds email values safely', async () => {
    const feedback = customerFeedbackService(config, db(), feedbackOptions({}), undefined, clock),
      input = { from: '2026-11-16T00:00:00', to: '2026-11-16T23:59:59', page: 1, pageSize: 25 };
    const report = await feedback.search(user, input);
    expect(report.reader).toBe('data');
    expect(report.total).toBe(2);
    expect(report.data.every((row) => row.order_id === '1001')).toBe(true);
    expect(report.data[0]?.email).toBe('fixture@example.test');
    const masked = await feedback.search({ ...user, userType: 2 }, { ...input, storeIds: ['1'] });
    expect(masked.total).toBe(2);
    expect(masked.data[0]).toMatchObject({
      name: 'F*****e',
      email: 'f******@e******.test',
      telephone: '********7890',
    });
    expect((await feedback.search({ ...user, userType: 2 }, input)).total).toBe(0);
    await expect(feedback.search(user, { ...input, storeIds: ['2'] })).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    expect(
      (await feedback.search(user, { ...input, email: "fixture@example.test' OR 1=1 --" })).total,
    ).toBe(0);
    const all = await feedback.search({ ...user, role: 1 }, input);
    expect(all.total).toBe(4);
    expect(all.data.some((row) => row.store_name === 'Online Orders')).toBe(true);
    expect(all.data.some((row) => row.order_id === '1004')).toBe(false);
  });
  it('matches the original parent-selection SQL, batches repairs and preserves existing stock/flags', async () => {
    const source = z.array(z.string()).parse(
        JSON.parse(
          executePosSourceOracle(['tools/operational-reports/inventory-oracle.py'], {
            input: JSON.stringify({ stores: [1] }),
            encoding: 'utf8',
          }),
        ),
      ),
      [expected] = await admin!.query<mysql.RowDataPacket[]>(source[0]!);
    expect(expected.map((row) => String(row.id)).sort()).toEqual(['100', '500', '600']);
    const inventory = inventoryAssociationService(db()),
      first = await inventory.ensureParents(user, '1', '0', 1);
    expect(first).toMatchObject({ ensuredParentIds: ['100'], hasMore: true, nextCursor: '100' });
    const next = await inventory.ensureParents(user, '1', first.nextCursor!, 500);
    expect(next.ensuredParentIds).toEqual(['500', '600']);
    expect(next.hasMore).toBe(false);
    const rows = await db()
      .get('writer')
      .select()
      .from(ProductStore)
      .where(and(eq(ProductStore.store, 1n), eq(ProductStore.product, 200n)));
    expect(rows[0]).toMatchObject({ stock: 12, is_avail: false, is_del: true });
    const inserted = await db()
      .get('writer')
      .select()
      .from(ProductStore)
      .where(and(eq(ProductStore.store, 1n), eq(ProductStore.product, 100n)));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ stock: 0, is_avail: true, is_del: false });
    expect((await inventory.ensureParents(user, '1')).ensuredParentIds).toEqual([]);
    await expect(inventory.ensureParents({ ...user, role: 5 }, '1')).rejects.toMatchObject({
      code: 'ROLE_ACCESS_DENIED',
    });
    await expect(inventory.ensureParents(user, '2')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await admin!.query('DELETE FROM user_stores WHERE django_user_id=900001');
    await expect(inventory.ensureParents(user, '1')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
  });
  it('deduplicates concurrent parent-association repairs using the shared store authority and unique key', async () => {
    await insert('user_stores', { id: 2, django_user_id: 900001, store_id: 1 });
    await db()
      .get('writer')
      .delete(ProductStore)
      .where(and(eq(ProductStore.store, 1n), inArray(ProductStore.product, [100n, 500n, 600n])));
    const service = inventoryAssociationService(db()),
      results = await Promise.all(
        Array.from({ length: 8 }, () => service.ensureParents(user, '1')),
      );
    expect(results.flatMap((result) => result.ensuredParentIds).sort()).toEqual([
      '100',
      '500',
      '600',
    ]);
    const rows = await db()
      .get('writer')
      .select()
      .from(ProductStore)
      .where(and(eq(ProductStore.store, 1n), inArray(ProductStore.product, [100n, 500n, 600n])));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.stock === 0 && row.is_avail && !row.is_del)).toBe(true);
  });
});
