import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  availableStockProjection,
  availableSystemStockProjection,
} from '../../src/db/stock-projection/service.js';
import { pythonRound2 } from '../../src/domain/python-round.js';
import type { Principal } from '../../src/domain/access.js';
import { memoryOrderRedis } from '../../src/modules/fulfillment/order-redis.js';
import {
  courierStatus,
  legacyFulfillmentActions,
} from '../../src/modules/legacy-fulfillment/actions.js';
import {
  hyperlocalGateway,
  type GatewayResponse,
  type HyperlocalGateway,
} from '../../src/modules/legacy-fulfillment/gateway.js';
import { hyperlocalLifecycle } from '../../src/modules/legacy-fulfillment/hyperlocal.js';
import { readLegacyFulfillmentOptions } from '../../src/modules/legacy-fulfillment/options.js';
import { pythonRepr, type PythonValue } from '../../src/modules/legacy-fulfillment/python-text.js';
import type { EnqueueOptions, JobArgs, JobName } from '../../src/jobs/contract.js';
import {
  lifecycleRuntime,
  type LegacyFulfillmentDependencies,
} from '../../src/modules/legacy-fulfillment/runtime.js';
import { lifecycleStock } from '../../src/modules/legacy-fulfillment/stock.js';
import { goldenSpawnResult } from '../golden/load.js';

/**
 * Pinned 78d5b63 legacy methods run by tools/legacy-fulfillment/{source,lifecycle}-oracle.py
 * (executed outside the repository with inert ORM/HTTP doubles) and replayed from
 * tests/golden/legacy-fulfillment/{domain,lifecycle-domain}.json.
 */
function oracle(name: 'domain' | 'lifecycle-domain', cases: unknown[]): unknown {
  const result = goldenSpawnResult('legacy-fulfillment', name, JSON.stringify(cases));
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}
const orderId = '9007199254740993';
// Helpers.transaction_logger(order_id, store_id, user_id, pos_user_id, pay_dict, comment).
const transaction = z.tuple([
  z.union([z.number(), z.string()]),
  z.number(),
  z.number(),
  z.number(),
  z.record(z.string(), z.unknown()),
  z.string(),
]);

describe('legacy local-delivery methods replayed from the pinned source', () => {
  it('AjaxCheckOrderStatusView.post branches (order/views.py:4041-4056)', () => {
    const logs = [
      null,
      ...['ACCEPTED', 'DECLINED', 'NO_ACTION', 'CREATION_FAILED', 'CONVERT_ONLINE'].flatMap(
        (action) =>
          [0, 1].map((createdInBorzo) => ({
            action,
            createdInBorzo,
            error: 'provider raw fixture detail' as string | null,
          })),
      ),
      { action: 'CREATION_FAILED', createdInBorzo: 0, error: null },
    ];
    const expected = z
      .array(z.object({ status: z.string(), message: z.string(), error: z.string() }))
      .parse(
        oracle(
          'domain',
          logs.map((log) => ({
            kind: 'status',
            log: log
              ? {
                  action: log.action,
                  is_created_in_borzo: log.createdInBorzo,
                  error_msg: log.error,
                }
              : null,
          })),
        ),
      );
    logs.forEach((log, index) =>
      expect(courierStatus(log), JSON.stringify(log)).toEqual(expected[index]),
    );
  });

  it('sends the legacy helper URLs, headers and JSON bodies for every courier/API-v2 call', async () => {
    const options = readLegacyFulfillmentOptions({
      TSS_OBERVER_URL: 'https://observer.example.test/',
      TSS_OBERVER_APP_ID: 'fixture-observer',
      TSS_OBERVER_APP_KEY: 'fixture-observer-key',
      MAIN_API_V2_URL: 'https://api.example.test/',
      ORDER_PRODUCER_URL: 'https://producer.example.test/',
      ORDER_PRODUCER_APP_ID: 'fixture-producer',
      ORDER_PRODUCER_APP_KEY: 'fixture-producer-key',
      MJML_HOST: 'https://mail.example.test/',
      TSS_JWT_HS256_KEY: 'fixture-hs256-key-'.repeat(3),
      TSS_JWT_HS512_KEY: 'fixture-hs512-key-'.repeat(3),
    });
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const gateway = hyperlocalGateway(
      { NODE_ENV: 'test' },
      options,
      async (input, init) => {
        sent.push({
          url: String(input),
          headers: { ...(init?.headers as Record<string, string>) },
          body: String(init?.body),
        });
        return new Response('{}', { status: 200 });
      },
      () => Date.parse('2026-11-19T06:30:00Z'),
    );
    const customer = { id: '7', twoFactor: false };
    const cases: { source: Record<string, unknown>; run: () => Promise<unknown> }[] = [
      {
        source: { method: 'create_borzo_order', args: [orderId, '1'] },
        run: () => gateway.createBorzoOrder(orderId, '1'),
      },
      {
        source: { method: 'place_online_order', args: [7, orderId, 0] },
        run: () => gateway.placeOnlineOrder(customer, orderId, false),
      },
      {
        source: { method: 'place_online_order', args: [7, orderId, 1] },
        run: () => gateway.placeOnlineOrder(customer, orderId, true),
      },
      {
        source: {
          method: 'hl_order_cancel_refund',
          args: [7, orderId, 'Fixture reason', 'webhook', 0],
        },
        run: () =>
          gateway.cancelRefund({
            customer,
            orderId,
            reason: 'Fixture reason',
            platform: 'webhook',
            splitProductIds: null,
          }),
      },
      {
        source: {
          method: 'hl_order_cancel_refund',
          args: [7, orderId, 'Fixture reason', 'webhook', 1],
          products: [10, 11],
        },
        run: () =>
          gateway.cancelRefund({
            customer,
            orderId,
            reason: 'Fixture reason',
            platform: 'webhook',
            splitProductIds: ['10', '11'],
          }),
      },
      {
        source: { method: 'refund_hl_charges_split', args: [orderId] },
        run: () => gateway.refundHlChargesSplit(orderId),
      },
      {
        source: { method: 'push_order_kinesis', args: [orderId] },
        run: () => gateway.pushOrderKinesis(orderId),
      },
      {
        source: { method: 'new_order_create_communication', args: [1008] },
        run: () => gateway.newOrderCommunication('1008'),
      },
      {
        source: {
          method: 'create_od_ticket',
          args: [orderId, 'Fixture', 'Fixture subject', 'Fixture description'],
        },
        run: () =>
          gateway.createOdTicket({
            orderId,
            name: 'Fixture',
            subject: 'Fixture subject',
            description: 'Fixture description',
          }),
      },
    ];
    const call = z.object({
      url: z.string(),
      headers: z.record(z.string(), z.string()),
      body: z.string(),
    });
    const source = z.array(z.object({ calls: z.array(call) })).parse(
      oracle(
        'lifecycle-domain',
        cases.map((value) => ({ kind: 'payload', ...value.source })),
      ),
    );
    for (const [index, value] of cases.entries()) {
      sent.length = 0;
      await value.run();
      const expected = source[index]!.calls;
      const label = JSON.stringify(value.source);
      expect(
        sent.map((row) => row.url),
        label,
      ).toEqual(expected.map((row) => row.url));
      expect(
        sent.map((row) => row.body),
        label,
      ).toEqual(expected.map((row) => row.body));
      sent.forEach((row, at) => {
        const legacy = expected[at]!.headers;
        // Legacy signs with a stubbed Helpers.create_token; the rewrite issues a real JWT.
        if ('Authorization' in legacy) expect(row.headers.Authorization, label).toMatch(/^ey/);
        const { Authorization: _rewrite, ...rest } = row.headers;
        const { Authorization: _legacy, ...legacyRest } = legacy;
        expect(rest, label).toEqual(legacyRest);
      });
    }
  });

  it('rounds wallet-history money with CPython round(float, 2), including binary ties', () => {
    const values = [
      2.675,
      2.685,
      1.005,
      -2.675,
      60.125,
      5e-324,
      -0.00001,
      123456789.555,
      1e20,
      Number.MAX_VALUE,
    ];
    const golden = goldenSpawnResult(
      'legacy-fulfillment',
      'lifecycle-domain',
      JSON.stringify([{ kind: 'round', values }]),
    );
    expect(golden.status).toBe(0);
    // Parse with exact float text; CPython prints -0.0 for round(-0.00001, 2).
    const expected = z.array(z.array(z.number())).parse(JSON.parse(golden.stdout) as unknown)[0]!;
    expect(values.map(pythonRound2)).toEqual(expected);
    expect(golden.stdout).toContain('-0.0');
    expect(Object.is(pythonRound2(-0.00001), -0)).toBe(true);
  });
});

const tables = [
  'stores',
  'orders',
  'products',
  'product_store',
  'pos_user',
  'user_stores',
  'hyperlocal_order_log',
  'has_products',
  'pos_transaction_logs',
  'product_stocks',
  'product_inventory_logs',
  'pos_inventory_sync_log',
  'products_inventory_logs',
  'pos_product_inventory_logs',
  'attributes',
  'has_options',
  'hold_stock_store',
  'pos_hold_stock_logs',
  'order_status',
  'order_addons',
  'pos_hyperlocal_slots',
];
const operator: Principal = {
  id: '44',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
const connection = process.env.MYSQL_INTEGRATION_URL;

describe.skipIf(!connection)(
  'legacy local-delivery stock and audit steps on isolated MySQL',
  () => {
    const schema = 'pos_w15_lf_golden_' + randomUUID().replaceAll('-', '').slice(0, 12);
    let admin: mysql.Connection, db: Databases, deps: LegacyFulfillmentDependencies;
    const query = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
      (await admin.query<mysql.RowDataPacket[]>(sql, values))[0] as T[];
    const inert = async (): Promise<GatewayResponse> => ({ status: 200, body: {}, text: '{}' });
    const gateway: HyperlocalGateway = {
      commonSlackUrl: undefined,
      commonAlertOn: false,
      createBorzoOrder: inert,
      cancelRefund: inert,
      placeOnlineOrder: inert,
      refundHlChargesSplit: inert,
      createOdTicket: inert,
      pushOrderKinesis: inert,
      slack: inert,
      newOrderCommunication: inert,
    };

    beforeAll(async () => {
      const url = new URL(connection!);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname))
        throw new Error('Loopback MySQL only.');
      admin = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
      await admin.changeUser({ database: schema });
      await admin.query("SET SESSION sql_mode=''");
      await admin.query('SET FOREIGN_KEY_CHECKS=0');
      const snapshot = JSON.parse(
        readFileSync('tests/golden/schema/production-schema.json', 'utf8'),
      ) as { tables: Record<string, { createTable: string }> };
      for (const table of tables) await admin.query(snapshot.tables[table]!.createTable);
      url.pathname = '/' + schema;
      const config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'legacy-local-delivery-golden-'.repeat(3),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      });
      db = createDatabases(config);
      const clock = () => Temporal.Instant.from('2026-11-19T06:30:00Z');
      deps = {
        config,
        db,
        env: readLegacyFulfillmentOptions({ HYPERLOCAL_CUT_OFF_SWITCH: '0' }),
        gateway,
        redis: memoryOrderRedis(),
        stockProcedure: availableStockProjection('Asia/Kolkata', clock),
        systemStockProcedure: availableSystemStockProjection('Asia/Kolkata', clock),
        publish: async () => {},
        clock,
      };
    });
    afterAll(async () => {
      await db?.close();
      await admin?.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
      await admin?.end();
    });
    beforeEach(async () => {
      for (const table of tables) await admin.query(`DELETE FROM ${mysql.escapeId(table)}`);
      await admin.query(
        `INSERT INTO stores (id, store_name, type, is_active, location_code, latitude, longitude, address, alt_address, phone, url_key, gstin)
       VALUES (1,'Fixture','STORE',1,'FIXTURE','','','','','p1','s1','')`,
      );
      await admin.query(
        "INSERT INTO pos_user (id, username, password, first_name, last_name, is_active, role, user_type) VALUES (44,'op','x','Fixture','Operator',1,4,1)",
      );
      await admin.query('INSERT INTO user_stores (django_user_id, store_id) VALUES (44,1)');
      await admin.query(
        "INSERT INTO order_status (id, order_status, display_name, cat) VALUES (1,'PLACED','Order Placed',1)",
      );
      await admin.query(
        'INSERT INTO products (id, product, prod_type, parent_prod_id, is_del) VALUES (10,"Tee",1,0,0),(11,"Cap",1,0,0)',
      );
      await admin.query(
        'INSERT INTO product_stocks (prod_id, parent_prod_id, stock, stocked) VALUES (10,0,10,0),(11,0,10,0)',
      );
    });

    it('HoldStockHelperClass hold/unhold arithmetic, messages and hold logs (inventory_helper.py)', async () => {
      const cases = [
        { action: 'hold_stock', stock: 5, held: null, quantity: 2 },
        { action: 'hold_stock', stock: 3, held: 2, quantity: 1 },
        { action: 'unhold_stock', stock: 2, held: 3, quantity: 2 },
        { action: 'unhold_stock', stock: 4, held: 1, quantity: 1 },
        { action: 'hold_stock', stock: 1, held: 0, quantity: 2 },
        { action: 'unhold_stock', stock: 2, held: 1, quantity: 2 },
        { action: 'unhold_stock', stock: 2, held: null, quantity: 1 },
      ] as const;
      const source = z
        .array(
          z.object({
            result: z.object({ status: z.enum(['success', 'fail']), message: z.string() }),
            stock: z.number(),
            held: z.number().nullable(),
            logs: z.array(
              z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.string()]),
            ),
          }),
        )
        .parse(
          oracle(
            'lifecycle-domain',
            cases.map((value) => ({ ...value, kind: 'hold' })),
          ),
        );
      const stock = lifecycleStock(lifecycleRuntime(deps));
      for (const [index, value] of cases.entries()) {
        await admin.query('DELETE FROM product_store');
        await admin.query('DELETE FROM hold_stock_store');
        await admin.query('DELETE FROM pos_hold_stock_logs');
        await admin.query(
          'INSERT INTO product_store (product_id, store_id, stock, is_avail, is_del) VALUES (10,1,?,1,0)',
          [value.stock],
        );
        if (value.held !== null)
          await admin.query(
            'INSERT INTO hold_stock_store (product_id, store_id, stock) VALUES (10,1,?)',
            [value.held],
          );
        const run = value.action === 'hold_stock' ? stock.hold : stock.unhold;
        const result = await run('10', '1', value.quantity, '0', 'Fixture lifecycle reservation');
        const expected = source[index]!;
        const label = JSON.stringify(value);
        expect(result, label).toEqual(expected.result);
        const [row] = await query<{ stock: number }>(
          'SELECT stock FROM product_store WHERE product_id=10 AND store_id=1',
        );
        expect(row?.stock, label).toBe(expected.stock);
        const held = await query<{ stock: number }>('SELECT stock FROM hold_stock_store');
        expect(held[0]?.stock ?? null, label).toBe(expected.held);
        expect(
          await query(
            'SELECT product_id, store_id, stock_before, stock_after, pos_user_id, comment FROM pos_hold_stock_logs ORDER BY id',
          ),
          label,
        ).toEqual(
          expected.logs.map(([product, store, before, after, user, comment]) => ({
            product_id: String(product),
            store_id: String(store),
            stock_before: String(before),
            stock_after: String(after),
            pos_user_id: String(user),
            comment,
          })),
        );
      }
    });

    it('AjaxOrderPackView / AjaxRtoRecievedView audit comments and restock; the repeat receipt is the approved restock-once correction', async () => {
      const notes = ['', 'Checked parcel', 'Euro € note', '<script>literal text</script>'];
      const lines = [
        { productId: '10', quantity: '2' },
        { productId: '10', quantity: '1' },
        { productId: '11', quantity: '5' },
      ];
      const stocks = [
        { product_id: '10', store_id: 1, stock: 3 },
        { product_id: '11', store_id: 1, stock: 4 },
      ];
      const cases = [
        ...notes.flatMap((note) =>
          ['packing', 'rto-receipt'].map((kind) => ({ kind, note, firstName: 'Fixture' })),
        ),
        ...[1, 2].map((repeat) => ({
          kind: 'rto-receipt',
          firstName: 'Fixture',
          note: 'Package received',
          lines,
          stocks,
          repeat,
        })),
      ];
      const source = z
        .array(
          z.object({
            flags: z.object({ is_pack: z.number(), rto_recieved: z.number() }),
            transactions: z.array(transaction),
            stocks: z.array(z.object({ productId: z.string(), stock: z.number() })),
          }),
        )
        .parse(oracle('domain', cases));
      const actions = legacyFulfillmentActions(lifecycleRuntime(deps));
      async function order() {
        for (const table of [
          'orders',
          'has_products',
          'hyperlocal_order_log',
          'pos_transaction_logs',
        ])
          await admin.query(`DELETE FROM ${mysql.escapeId(table)}`);
        await admin.query('DELETE FROM product_store');
        await admin.query(
          "INSERT INTO orders (id, user_id, payment_status, order_status, location_type, location_id, next_location_ids, is_transfer, is_split_order) VALUES (1001,7,4,1,'SW',1,'[]',0,0)",
        );
        await admin.query(
          "INSERT INTO hyperlocal_order_log (order_id, action, is_rto, delivery_exception_date, created_at, updated_at) VALUES (1001,'ACCEPTED',1,'2026-11-19 11:00:00','2026-11-19 11:00:00','2026-11-19 11:00:00')",
        );
        for (const [index, line] of lines.entries())
          await admin.query(
            "INSERT INTO has_products (id, order_id, prod_id, qty, status, order_platform_id) VALUES (?,1001,?,?,'PLACED',4)",
            [9001 + index, line.productId, line.quantity],
          );
        for (const row of stocks)
          await admin.query(
            'INSERT INTO product_store (product_id, store_id, stock, is_avail, is_del) VALUES (?,?,?,1,0)',
            [row.product_id, row.store_id, row.stock],
          );
      }
      const logged = () =>
        query<{ store_id: string; pos_user_id: string; pay_dict: string; comment: string }>(
          'SELECT store_id, pos_user_id, pay_dict, comment FROM pos_transaction_logs ORDER BY id',
        );
      const asRows = (rows: z.infer<typeof transaction>[]) =>
        rows.map(([, store, , user, pay, comment]) => ({
          store_id: String(store),
          pos_user_id: String(user),
          pay_dict: JSON.stringify(pay),
          comment,
        }));
      for (const [index, value] of cases.slice(0, notes.length * 2).entries()) {
        await order();
        if (value.kind === 'packing') await actions.pack(operator, '1', '1001', value.note);
        else await actions.receiveRto(operator, '1', '1001', value.note);
        const expected = source[index]!;
        expect(await logged(), JSON.stringify(value)).toEqual(asRows(expected.transactions));
        expect(
          await query('SELECT is_pack, rto_recieved FROM hyperlocal_order_log'),
          JSON.stringify(value),
        ).toEqual([{ is_pack: expected.flags.is_pack, rto_recieved: expected.flags.rto_recieved }]);
      }
      const [once, twice] = source.slice(notes.length * 2);
      await order();
      await actions.receiveRto(operator, '1', '1001', 'Package received');
      const restocked = () =>
        query<{ productId: string; stock: number }>(
          'SELECT product_id AS productId, stock FROM product_store WHERE store_id=1 ORDER BY product_id',
        );
      expect(await restocked()).toEqual(once!.stocks);
      expect(await logged()).toEqual(asRows(once!.transactions));
      // Legacy restocks and logs again on a repeated receipt (twice!.stocks); the rewrite gates on
      // hyperlocal_order_log.rto_recieved and restocks once (approved correction, w5 ledger).
      expect(twice!.stocks).toEqual([
        { productId: '10', stock: 9 },
        { productId: '11', stock: 14 },
      ]);
      expect(await actions.receiveRto(operator, '1', '1001', 'Package received')).toMatchObject({
        alreadyRecorded: true,
      });
      expect(await restocked()).toEqual(once!.stocks);
    });
    /** The lifecycle with recording stock/notice/Slack/job doubles at the legacy call boundaries. */
    function recordingLifecycle(cutoff: boolean, localNow: string) {
      const clock = () =>
        Temporal.PlainDateTime.from(localNow).toZonedDateTime('Asia/Kolkata').toInstant();
      const jobs: { name: JobName; args: JobArgs; options: EnqueueOptions }[] = [];
      const runtime = lifecycleRuntime({
        ...deps,
        env: readLegacyFulfillmentOptions({ HYPERLOCAL_CUT_OFF_SWITCH: cutoff ? '1' : '0' }),
        clock,
        jobs: {
          async enqueue(name, args, options) {
            jobs.push({ name, args, options });
            return { jobId: randomUUID(), name, queue: options.queue, dueAt: 0 };
          },
        },
      });
      const held: {
        kind: 'hold' | 'release';
        args: number[];
        kwargs: { extra_message: string };
      }[] = [];
      const notices: { args: PythonValue[]; kwargs: Record<string, PythonValue> }[] = [];
      const slack: { args: string[]; kwargs: Record<string, string> }[] = [];
      const real = lifecycleStock(runtime);
      const record =
        (kind: 'hold' | 'release') =>
        async (product: string, store: string, quantity: number, user: string, message = '') => {
          held.push({
            kind,
            args: [Number(product), Number(store), quantity, Number(user)],
            kwargs: { extra_message: message },
          });
          return { status: 'success' as const, message: '' };
        };
      const lifecycle = hyperlocalLifecycle(
        {
          ...runtime,
          orderCreationBufferSeconds: async () => 3600,
          async orderNotification(title, order, store, input) {
            notices.push({
              args: [title, order, Number(store)],
              kwargs: {
                ...(input!.isSlack !== undefined ? { is_slack: input!.isSlack } : {}),
                ...(input!.isNewOrder !== undefined ? { is_new_order: input!.isNewOrder } : {}),
                ...(input!.flag !== undefined ? { flag: input!.flag } : {}),
                ...(input!.staffUser !== undefined ? { staff_user: input!.staffUser } : {}),
                ...(input!.reason !== undefined ? { reason: input!.reason } : {}),
              },
            });
          },
          async slackText(message, input) {
            slack.push({ args: [message], kwargs: input!.flag ? { flag: input!.flag } : {} });
          },
        },
        { ...real, hold: record('hold'), unhold: record('release') },
      );
      return { lifecycle, jobs, held, notices, slack };
    }
    async function hyperlocalOrder(values: {
      next: string;
      transferred: number;
      split: number;
      start?: string;
    }) {
      for (const table of ['orders', 'has_products', 'order_addons', 'pos_transaction_logs'])
        await admin.query(`DELETE FROM ${mysql.escapeId(table)}`);
      await admin.query(
        "INSERT INTO orders (id, user_id, payment_status, order_status, location_type, location_id, next_location_ids, is_transfer, is_split_order, start_timeslot) VALUES (1001,7,4,1,'SW',1,?,?,?,?)",
        [values.next, values.transferred, values.split, values.start ?? '2026-11-16 10:00:00'],
      );
      // The oracle's lines: product 10+i, quantity i+1, platforms [4, 4, 1].
      for (const [index, platform] of [4, 4, 1].entries())
        await admin.query(
          "INSERT INTO has_products (id, order_id, prod_id, qty, status, order_platform_id) VALUES (?,1001,?,?,'PLACED',?)",
          [9001 + index, 10 + index, index + 1, platform],
        );
      await admin.query(
        "INSERT INTO order_addons (order_id, order_success_timestamp, created_at, updated_at) VALUES (1001,'2026-11-16 09:00:00','2026-11-16 09:00:00','2026-11-16 09:00:00')",
      );
    }

    it('auto_hl_order_transfer selection, holds, notices, jobs and audits (order/views.py:3844-3935)', async () => {
      const cases = [
        { nextIds: '[2,3]', transferred: 0, automatic: false, cutoff: false, split: 1 },
        { nextIds: '[2,3]', transferred: 0, automatic: true, cutoff: false, split: 1 },
        { nextIds: '[2,3]', transferred: 0, automatic: true, cutoff: true, split: 1 },
        { nextIds: '[2,3]', transferred: 1, automatic: false, cutoff: false, split: 1 },
        { nextIds: '[]', transferred: 0, automatic: false, cutoff: false, split: 0 },
        { nextIds: 'invalid', transferred: 0, automatic: false, cutoff: false, split: 1 },
        { nextIds: '[2,3]', transferred: 0, automatic: false, cutoff: true, split: 0 },
      ];
      const now = '2026-11-16T13:30:00';
      const source = z
        .array(
          z.object({
            result: z.tuple([z.string(), z.string()]),
            transferred: z.number(),
            held: z.array(
              z.object({
                kind: z.enum(['hold', 'release']),
                args: z.array(z.number()),
                kwargs: z.object({ extra_message: z.string() }),
              }),
            ),
            notices: z.array(
              z.object({ args: z.array(z.unknown()), kwargs: z.record(z.string(), z.unknown()) }),
            ),
            jobs: z.array(
              z.object({ args: z.array(z.unknown()), countdown: z.number(), queue: z.string() }),
            ),
            audits: z.array(transaction),
            slack: z.array(
              z.object({ args: z.array(z.string()), kwargs: z.record(z.string(), z.string()) }),
            ),
          }),
        )
        .parse(
          oracle(
            'lifecycle-domain',
            cases.map((value) => ({ ...value, kind: 'transfer', now, orderId: '1001' })),
          ),
        );
      const names = ['order_id', 'store_id', 'platform', 'next_ids', 'reason', 'staff_user'];
      for (const [index, value] of cases.entries()) {
        const label = JSON.stringify(value);
        await hyperlocalOrder({
          next: value.nextIds,
          transferred: value.transferred,
          split: value.split,
        });
        const run = recordingLifecycle(value.cutoff, now);
        const result = await run.lifecycle.transfer('1001', {
          staffUser: 'Fixture Manager',
          reason: 'Fixture reason',
          isAuto: value.automatic,
          reasonDropdown: 'Fixture category',
        });
        const expected = source[index]!;
        expect([result.message, result.opr], label).toEqual(expected.result);
        expect(
          (await query<{ is_transfer: number }>('SELECT is_transfer FROM orders'))[0]!.is_transfer,
          label,
        ).toBe(expected.transferred);
        expect(run.held, label).toEqual(expected.held);
        expect(run.notices, label).toEqual(expected.notices);
        expect(run.slack, label).toEqual(expected.slack);
        expect(
          await query(
            'SELECT store_id, pos_user_id, comment FROM pos_transaction_logs ORDER BY id',
          ),
          label,
        ).toEqual(
          expected.audits.map(([, store, , user, , comment]) => ({
            store_id: String(store),
            pos_user_id: String(user),
            comment,
          })),
        );
        expect(run.jobs, label).toHaveLength(expected.jobs.length);
        run.jobs.forEach((job, at) => {
          const legacy = expected.jobs[at]!;
          expect(job.name).toBe('order.views.auto_hl_order_to_online');
          expect(job.options, label).toEqual({
            queue: legacy.queue,
            delaySeconds: Math.max(0, legacy.countdown),
          });
          const positional: Record<string, unknown> = {
            reason: '',
            staff_user: '',
            reason_dropdown: '',
          };
          legacy.args.forEach((arg, slot) => (positional[names[slot] ?? 'reason_dropdown'] = arg));
          if (legacy.args.length === 6) {
            // views.py:3915 passes the pass reason positionally into staff_user; approved fix
            // (AGENTS.md, Orders): it goes to reason_dropdown and staff_user keeps the staff name.
            expect(positional.staff_user).toBe('Fixture category');
            Object.assign(positional, {
              staff_user: 'Fixture Manager',
              reason_dropdown: 'Fixture category',
            });
          }
          expect(job.args, label).toEqual({
            order_id: String(positional.order_id),
            store_id: String(positional.store_id),
            platform: positional.platform,
            next_ids:
              typeof positional.next_ids === 'string'
                ? positional.next_ids
                : pythonRepr(positional.next_ids as PythonValue),
            reason: positional.reason,
            staff_user: positional.staff_user,
            reason_dropdown: positional.reason_dropdown,
          });
        });
      }
    });

    it('AutoHlOrderView.post advance slots, cut-off and buffer scheduling (order/views.py:3675-3720)', async () => {
      const cases = [
        {
          now: '2026-11-16T13:30:00',
          orderStart: '2026-11-16 10:00:00',
          slotStart: '10:00:00',
          cutoff: true,
        },
        {
          now: '2026-11-16T09:00:00',
          orderStart: '2026-11-16 11:00:00',
          slotStart: '10:00:00',
          cutoff: true,
        },
        {
          now: '2026-11-16T13:30:00',
          orderStart: '2026-11-17 11:00:00',
          slotStart: '10:00:00',
          cutoff: true,
        },
        {
          now: '2026-11-16T09:00:00.750',
          orderStart: '2026-11-16 11:00:00',
          slotStart: '10:00:00',
          cutoff: false,
        },
        {
          now: '2026-11-16T18:00:00',
          orderStart: '2026-11-16 10:00:00',
          slotStart: '10:00:00',
          cutoff: true,
        },
        {
          now: '2026-11-16T13:30:00',
          orderStart: '2026-11-17 11:00:00',
          slotStart: null,
          cutoff: false,
        },
        {
          now: '2026-11-21T13:30:00',
          orderStart: '2026-11-22 11:00:00',
          slotStart: '12:00:00',
          cutoff: false,
        },
        {
          now: '2026-11-16T16:59:59.999',
          orderStart: '2026-11-16 10:00:00',
          slotStart: null,
          cutoff: true,
        },
      ];
      const source = z
        .array(
          z.object({
            advance: z.boolean(),
            successTimestamp: z.string().nullable(),
            jobs: z.array(z.object({ name: z.string(), countdown: z.number() })),
            notices: z.array(z.unknown()),
          }),
        )
        .parse(
          oracle(
            'lifecycle-domain',
            cases.map((value) => ({
              ...value,
              kind: 'arrival',
              orderId: '1001',
              storeId: '1',
              notify: true,
              buffer: 3600,
            })),
          ),
        );
      const jobName = {
        'advance-notification': 'order.views.advance_order_notification',
        'auto-transfer': 'order.views.auto_hl_order_transfer',
      } as const;
      for (const [index, value] of cases.entries()) {
        const label = JSON.stringify(value);
        await hyperlocalOrder({ next: '[]', transferred: 0, split: 1, start: value.orderStart });
        await admin.query('DELETE FROM pos_hyperlocal_slots');
        if (value.slotStart)
          for (const day of ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])
            await admin.query(
              "INSERT INTO pos_hyperlocal_slots (store_id, weekday, start_timeslot, end_timeslot, created_at, updated_at) VALUES (1,?,?,'23:00:00','2026-11-01 00:00:00','2026-11-01 00:00:00')",
              [day, value.slotStart],
            );
        const run = recordingLifecycle(value.cutoff, value.now);
        await run.lifecycle.arrival('1001', '1', true);
        const expected = source[index]!;
        const [addon] = await query<{ at: string }>(
          'SELECT order_success_timestamp AS at FROM order_addons',
        );
        expect(addon!.at, label).toBe(expected.successTimestamp ?? '2026-11-16 09:00:00');
        expect(
          run.jobs.map((job) => ({ name: job.name, delaySeconds: job.options.delaySeconds })),
          label,
        ).toEqual(
          expected.jobs.map((job) => ({
            name: jobName[job.name as keyof typeof jobName],
            delaySeconds: Math.max(0, job.countdown),
          })),
        );
        expect(run.notices.length, label).toBe(expected.notices.length);
        expect(
          run.held.map((row) => row.args),
          label,
        ).toEqual([
          [10, 1, 1, 0],
          [11, 1, 2, 0],
        ]);
      }
    });
  },
);
