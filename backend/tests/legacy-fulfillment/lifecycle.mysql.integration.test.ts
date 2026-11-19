import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  availableStockProjection,
  availableSystemStockProjection,
} from '../../src/db/stock-projection/service.js';
import type { Principal } from '../../src/domain/access.js';
import type {
  EnqueueOptions,
  JobArgs,
  JobHandler,
  JobName,
  JobProducer,
} from '../../src/jobs/contract.js';
import { memoryOrderRedis } from '../../src/modules/fulfillment/order-redis.js';
import { legacyFulfillmentActions } from '../../src/modules/legacy-fulfillment/actions.js';
import type {
  GatewayResponse,
  HyperlocalGateway,
} from '../../src/modules/legacy-fulfillment/gateway.js';
import { registerJobHandlers } from '../../src/modules/legacy-fulfillment/jobs.js';
import { readLegacyFulfillmentOptions } from '../../src/modules/legacy-fulfillment/options.js';
import {
  lifecycleRuntime,
  type LegacyFulfillmentDependencies,
  type NoticePublication,
} from '../../src/modules/legacy-fulfillment/runtime.js';

const tables = [
  'stores',
  'orders',
  'products',
  'product_store',
  'pos_user',
  'user_stores',
  'hyperlocal_order_log',
  'hyperlocal_fd_logs',
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
  'pos_hyperlocal_slots',
  'tss_settings',
  'order_addons',
  'users',
  'tss_money_history',
  'hyperlocal_to_online_order_logs',
  'pos_notifications',
  'pos_user_notifications',
  'order_status',
  'amount_to_be_refunded_log',
];
const operator: Principal = {
  id: '44',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1', '2'],
};
const ok = (body: unknown): GatewayResponse => ({ status: 200, body, text: JSON.stringify(body) });
const connection = process.env.MYSQL_INTEGRATION_URL;

describe.skipIf(!connection)('legacy hyperlocal lifecycle on isolated local MySQL', () => {
  const schema = 'pos_w5_local_delivery_' + randomUUID().replaceAll('-', '').slice(0, 12);
  let admin: mysql.Connection, db: Databases;
  const calls: { kind: string; args: unknown[] }[] = [];
  const jobs: { name: JobName; args: JobArgs; options: EnqueueOptions }[] = [];
  const published: NoticePublication[] = [];
  const responses: Partial<Record<string, GatewayResponse>> = {};
  const redis = memoryOrderRedis();
  const gateway: HyperlocalGateway = {
    commonSlackUrl: 'https://hooks.slack.com/services/common',
    commonAlertOn: false,
    createBorzoOrder: async (...args) => record('borzo', args),
    cancelRefund: async (...args) => record('cancel', args),
    placeOnlineOrder: async (...args) => record('online', args),
    refundHlChargesSplit: async (...args) => record('split-refund', args),
    createOdTicket: async (...args) => record('ticket', args),
    pushOrderKinesis: async (...args) => record('kinesis', args),
    slack: async (...args) => record('slack', args),
    newOrderCommunication: async (...args) => record('mailr', args),
  };
  async function record(kind: string, args: unknown[]) {
    calls.push({ kind, args });
    return responses[kind] ?? ok({});
  }
  const producer: JobProducer = {
    async enqueue(name, args, options) {
      jobs.push({ name, args, options });
      return { jobId: randomUUID(), name, queue: options.queue, dueAt: 0 };
    },
  };
  let deps: LegacyFulfillmentDependencies;
  const query = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await admin.query<mysql.RowDataPacket[]>(sql, values))[0] as T[];

  beforeAll(async () => {
    const url = new URL(connection!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Loopback MySQL only.');
    admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await admin.changeUser({ database: schema });
    await admin.query("SET SESSION sql_mode=''");
    await admin.query('SET FOREIGN_KEY_CHECKS=0');
    const snapshot = JSON.parse(
      readFileSync('tests/golden/schema/production-schema.json', 'utf8'),
    ) as {
      tables: Record<string, { createTable: string }>;
    };
    for (const table of tables) await admin.query(snapshot.tables[table]!.createTable);
    url.pathname = '/' + schema;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'legacy-local-delivery-'.repeat(3),
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_DATA_READER_URL: url.href,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    });
    db = createDatabases(config);
    const clock = () => Temporal.Instant.from('2026-11-19T06:30:00Z'); // 12:00 IST
    deps = {
      config,
      db,
      env: readLegacyFulfillmentOptions({ HYPERLOCAL_CUT_OFF_SWITCH: '0' }),
      gateway,
      redis,
      jobs: producer,
      stockProcedure: availableStockProjection('Asia/Kolkata', clock),
      systemStockProcedure: availableSystemStockProjection('Asia/Kolkata', clock),
      publish: async (event) => {
        published.push(event);
      },
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
    calls.length = 0;
    jobs.length = 0;
    published.length = 0;
    for (const key of Object.keys(responses)) delete responses[key];
    await redis.del(['check_in_list_1']);
    redis.lPush('check_in_list_1', '44');
    await admin.query(
      `INSERT INTO stores (id, store_name, type, is_active, location_code, slack_group_url, latitude, longitude, address, alt_address, phone, url_key, gstin) VALUES
       (1,'Store One','STORE',1,'S1','https://hooks.slack.com/services/store-one','','','','','p1','s1',''),
       (2,'Store Two','STORE',1,'S2',NULL,'','','','','p2','s2','')`,
    );
    await admin.query(
      "INSERT INTO pos_user (id, username, password, first_name, last_name, is_active, role, user_type) VALUES (44,'op','x','Asha','Rao',1,4,1)",
    );
    await admin.query('INSERT INTO user_stores (django_user_id, store_id) VALUES (44,1),(44,2)');
    await admin.query(
      "INSERT INTO order_status (id, order_status, display_name, cat) VALUES (1,'PLACED','Order Placed',1),(4,'CANCELLED','Cancelled',1),(21,'PROCESSING','Processing',1)",
    );
    await admin.query(
      "INSERT INTO users (id, firstname, telephone, email, tss_money, cashback, is_two_fa) VALUES (7,'Ravi','9000000000','ravi@example.test',100,100,0)",
    );
    await admin.query(
      `INSERT INTO products (id, product, prod_type, parent_prod_id, is_del) VALUES (501,'Tee',1,0,0),(502,'Cap',1,0,0)`,
    );
    await admin.query(
      'INSERT INTO product_stocks (prod_id, parent_prod_id, stock, stocked) VALUES (501,0,10,0),(502,0,10,0)',
    );
    await admin.query(
      'INSERT INTO product_store (product_id, store_id, stock, is_avail, is_del) VALUES (501,1,5,1,0),(502,1,5,1,0),(501,2,4,1,0),(502,2,4,1,0)',
    );
    await admin.query(
      `INSERT INTO orders (id, user_id, payment_status, order_status, location_type, location_id, next_location_ids, is_transfer, start_timeslot, is_split_order, hl_parent_order_id)
       VALUES (1001,7,4,1,'SW',1,'[2]',0,'2026-11-19 10:00:00',0,NULL)`,
    );
    await admin.query(
      `INSERT INTO has_products (id, order_id, prod_id, qty, status, order_platform_id) VALUES (9001,1001,501,1,'PLACED',4),(9002,1001,502,2,'PLACED',4)`,
    );
    await admin.query(
      "INSERT INTO order_addons (order_id, order_success_timestamp, created_at, updated_at) VALUES (1001,'2026-11-19 11:00:00','2026-11-19 11:00:00','2026-11-19 11:00:00')",
    );
    await admin.query(
      "INSERT INTO tss_settings (id, name, platform, value, status) VALUES (1,'buffer','ORDER_CREATION_BUFFER_TIME_IN_SEC','900',1)",
    );
  });

  it('AutoHlOrderView holds stock, notifies the checked-in users and schedules O2 after the buffer', async () => {
    const actions = legacyFulfillmentActions(lifecycleRuntime(deps));
    await actions.lifecycle.arrival('1001', '1', true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      await query('SELECT product_id, store_id, stock FROM hold_stock_store ORDER BY product_id'),
    ).toEqual([
      { product_id: '501', store_id: '1', stock: 1 },
      { product_id: '502', store_id: '1', stock: 2 },
    ]);
    expect(
      await query(
        'SELECT product_id, stock FROM product_store WHERE store_id=1 ORDER BY product_id',
      ),
    ).toEqual([
      { product_id: '501', stock: 4 },
      { product_id: '502', stock: 3 },
    ]);
    expect(
      (await query<{ comment: string }>('SELECT comment FROM pos_hold_stock_logs ORDER BY id'))[0]!
        .comment,
    ).toBe(
      'Hold Stock inventory added into Hold Stock Hyperlocal Order placed, inventory hold for order 1001',
    );
    expect(jobs).toEqual([
      {
        name: 'order.views.auto_hl_order_transfer',
        args: { order_id: '1001' },
        options: { queue: 'order_create', delaySeconds: 900 },
      },
    ]);
    expect(await query('SELECT title, store_id FROM pos_notifications')).toEqual([
      { title: 'Hyperlocal Order to Store One', store_id: 1 },
    ]);
    expect(await query('SELECT pos_admin_id FROM pos_user_notifications')).toEqual([
      { pos_admin_id: 44 },
    ]);
    expect(published[0]).toMatchObject({ storeId: '1', userIds: ['44'], isNewOrder: true });
    expect(calls.find((call) => call.kind === 'slack')?.args).toEqual([
      { url: 'https://hooks.slack.com/services/store-one' },
      '🛵 Order Id: 1001, Hyperlocal Order to Store One',
    ]);
    expect(await query('SELECT store_id, pos_user_id, comment FROM pos_transaction_logs')).toEqual([
      {
        store_id: '1',
        pos_user_id: '0',
        comment: 'Hyperlocal Order first lands on Store One and backup stores are Store Two, ',
      },
    ]);
  });

  it('O2 transfers to the backup store, moves the holds and schedules O3 with the legacy positional args', async () => {
    const runtime = lifecycleRuntime(deps),
      actions = legacyFulfillmentActions(runtime);
    await actions.lifecycle.arrival('1001', '1', false);
    jobs.length = 0;
    calls.length = 0;
    const handlers = new Map<JobName, JobHandler>();
    registerJobHandlers({ register: (name, handler) => handlers.set(name, handler) }, deps);
    const context = {
      jobId: 'j',
      name: 'order.views.auto_hl_order_transfer' as const,
      requestId: null,
      userId: null,
      signal: new AbortController().signal,
    };
    await handlers.get('order.views.auto_hl_order_transfer')!({ order_id: '1001' }, context);
    expect(await query('SELECT is_transfer FROM orders WHERE id=1001')).toEqual([
      { is_transfer: 1 },
    ]);
    expect(
      await query(
        'SELECT product_id, store_id, stock FROM hold_stock_store ORDER BY store_id, product_id',
      ),
    ).toEqual([
      { product_id: '501', store_id: '1', stock: 0 },
      { product_id: '502', store_id: '1', stock: 0 },
      { product_id: '501', store_id: '2', stock: 1 },
      { product_id: '502', store_id: '2', stock: 2 },
    ]);
    expect(
      await query(
        'SELECT store_id, product_id, stock FROM product_store ORDER BY store_id, product_id',
      ),
    ).toEqual([
      { store_id: '1', product_id: '501', stock: 5 },
      { store_id: '1', product_id: '502', stock: 5 },
      { store_id: '2', product_id: '501', stock: 3 },
      { store_id: '2', product_id: '502', stock: 2 },
    ]);
    expect(jobs).toEqual([
      {
        name: 'order.views.auto_hl_order_to_online',
        args: {
          order_id: '1001',
          store_id: '1',
          platform: 'CONVERT_ONLINE',
          next_ids: '[2]',
          reason: '',
          staff_user: '',
          reason_dropdown: '',
        },
        options: { queue: 'order_create', delaySeconds: 900 },
      },
    ]);
    const slack = calls.filter((call) => call.kind === 'slack').map((call) => call.args[1]);
    expect(slack).toEqual([
      '❌ 🛵 Order Id: 1001, Hyperlocal Order Transferred to Store Two',
      '⏱️ Order wait time exceeded for ID: 1001',
    ]);
    expect(
      await query(
        "SELECT comment FROM pos_transaction_logs WHERE comment LIKE 'Hyperlocal Order has been%'",
      ),
    ).toEqual([{ comment: 'Hyperlocal Order has been Transferred to the other stores, [2]' }]);
    // A second run re-checks the durable guard and only alerts.
    jobs.length = 0;
    await handlers.get('order.views.auto_hl_order_transfer')!({ order_id: '1001' }, context);
    expect(jobs).toEqual([
      expect.objectContaining({
        name: 'order.views.auto_hl_order_to_online',
        options: { queue: 'order_create', delaySeconds: 0 },
      }),
    ]);
  });

  it('O3 converts to an online order, refunds HL charges and enqueues C9', async () => {
    const actions = legacyFulfillmentActions(lifecycleRuntime(deps));
    responses.online = ok({ order: 7777, hl_charges_to_be_refunded: 50 });
    const result = await actions.lifecycle.toOnline({
      orderId: '1001',
      storeId: '1',
      platform: 'CONVERT_ONLINE',
      nextIds: '[2]',
      reason: '',
      staffUser: '',
      reasonDropdown: '',
    });
    expect(result).toEqual({ status: 201, message: 'Order Succesfully convert to online' });
    expect(
      await query(
        'SELECT new_order_id, platform, location_type, location_id, location_ids FROM hyperlocal_to_online_order_logs',
      ),
    ).toEqual([
      {
        new_order_id: '7777',
        platform: 'CONVERT_ONLINE',
        location_type: 'SW',
        location_id: '1',
        location_ids: '[2]',
      },
    ]);
    expect(
      await query(
        'SELECT action, delivery_exception_date FROM hyperlocal_order_log WHERE order_id=1001',
      ),
    ).toEqual([{ action: 'CONVERT_ONLINE', delivery_exception_date: '0000-00-00 00:00:00' }]);
    expect(await query('SELECT payment_status, order_status FROM orders WHERE id=1001')).toEqual([
      { payment_status: 5, order_status: 4 },
    ]);
    expect(await query('SELECT DISTINCT status FROM has_products WHERE order_id=1001')).toEqual([
      { status: 'CANCELLED' },
    ]);
    expect(
      await query(
        'SELECT added_amt, amt_before_update, amt_after_update, platform FROM tss_money_history',
      ),
    ).toEqual([
      { added_amt: 50, amt_before_update: 100, amt_after_update: 150, platform: 'ORDER_REFUND' },
    ]);
    expect(await query('SELECT tss_money, cashback FROM users WHERE id=7')).toEqual([
      { tss_money: 150, cashback: 150 },
    ]);
    expect(
      await query(
        "SELECT pay_dict FROM pos_transaction_logs WHERE comment LIKE 'Hyperlocal Charges Refunded%'",
      ),
    ).toEqual([{ pay_dict: "{'Hyperlocal Charges refunded into tss money': 50}" }]);
    expect(jobs).toEqual([
      {
        name: 'core.tasks.new_order_create_communication',
        args: { order_id: '7777' },
        options: { queue: 'core' },
      },
    ]);
    expect(calls.find((call) => call.kind === 'ticket')?.args[0]).toEqual({
      orderId: '1001',
      name: 'Ravi',
      subject: 'Hyperlocal order convert into online',
      description:
        'User Mobile 9000000000 and email ravi@example.test | Order ID : 1001 | New Order ID : 7777',
      reason: '',
      newOrder: '7777',
      staffUser: '',
    });
    // The child-order and action guards make a replay a no-op.
    expect(
      await actions.lifecycle.toOnline({
        orderId: '1001',
        storeId: '1',
        platform: 'CONVERT_ONLINE',
        nextIds: '[2]',
        reason: '',
        staffUser: '',
        reasonDropdown: '',
      }),
    ).toEqual({ status: 400, message: 'Order Already CONVERT_ONLINE' });
  });

  it('AjaxHlOrderView.create records the courier order and moves the order to processing', async () => {
    await admin.query(
      "INSERT INTO hyperlocal_order_log (order_id, action, delivery_exception_date, created_at, updated_at) VALUES (1001,'NO_ACTION','2026-11-19 11:00:00','2026-11-19 11:00:00','2026-11-19 11:00:00')",
    );
    responses.borzo = ok({
      is_successful: true,
      order: {
        order_id: 555,
        points: [{ tracking_url: 'https://t.example/a' }, { tracking_url: 'https://t.example/b' }],
      },
    });
    const actions = legacyFulfillmentActions(lifecycleRuntime(deps));
    expect(await actions.create(operator, '1', '1001')).toEqual({
      status: '200',
      message: 'Success',
    });
    expect(
      await query(
        'SELECT action, borzo_id, is_created_in_borzo, source_tracking_url, pos_admin_id, borzo_resp FROM hyperlocal_order_log',
      ),
    ).toEqual([
      {
        action: 'ACCEPTED',
        borzo_id: '555',
        is_created_in_borzo: 1,
        source_tracking_url: 'https://t.example/a',
        pos_admin_id: 44,
        borzo_resp:
          '{"is_successful": true, "order": {"order_id": 555, "points": [{"tracking_url": "https://t.example/a"}, {"tracking_url": "https://t.example/b"}]}}',
      },
    ]);
    expect(await query('SELECT location_id, order_status FROM orders WHERE id=1001')).toEqual([
      { location_id: 1, order_status: 21 },
    ]);
    expect(calls.map((call) => call.kind)).toEqual(['borzo', 'kinesis', 'slack']);
    await expect(actions.create(operator, '1', '1001')).rejects.toMatchObject({
      status: 409,
      message: 'Order: Order Already created',
    });
    const status = await actions.status(operator, '1', '1001');
    expect(status.check).toEqual({
      status: '200',
      message: 'Order Created Succesfully at Borzo',
      error: '',
    });
  });

  it('the observer webhook cancels, refunds and restocks without marking the log DECLINED', async () => {
    await admin.query(
      "INSERT INTO hyperlocal_order_log (order_id, action, delivery_exception_date, created_at, updated_at) VALUES (1001,'ACCEPTED','2026-11-19 11:00:00','2026-11-19 11:00:00','2026-11-19 11:00:00')",
    );
    await admin.query(
      'INSERT INTO amount_to_be_refunded_log (order_id, prod_id, tss_point_used, tss_money_used, gift_voucher_amount, coupon_amt_used, amount_to_be_refunded, refunded_amt) VALUES (1001,501,0,12.5,0,0,0,0)',
    );
    const actions = legacyFulfillmentActions(lifecycleRuntime(deps));
    expect(
      await actions.lifecycle.webhookCancel({
        orderId: '1001',
        storeId: '1',
        platform: 'rto',
        notify: false,
        title: '',
      }),
    ).toEqual({ ok: true, error: {} });
    expect(calls[0]).toEqual({
      kind: 'cancel',
      args: [
        {
          customer: { id: '7', twoFactor: false },
          orderId: '1001',
          reason: 'RTO-intransit',
          platform: 'webhook',
          splitProductIds: null,
        },
      ],
    });
    expect(await query('SELECT action FROM hyperlocal_order_log')).toEqual([
      { action: 'ACCEPTED' },
    ]);
    expect(await query('SELECT comment, pay_dict FROM pos_transaction_logs ORDER BY id')).toEqual([
      { comment: 'Hyperlocal Order Cancelled : Amount Refunded', pay_dict: '{}' },
      {
        comment: 'Hyperlocal Order cancel refund for Product id: 501',
        pay_dict:
          "{'tss point refunded': 0.0, 'tss money refunded': 12.5, 'gift voucher amount refunded': 0.0}",
      },
    ]);
    expect(
      await query(
        'SELECT product_id, stock FROM product_store WHERE store_id=1 ORDER BY product_id',
      ),
    ).toEqual([
      { product_id: '501', stock: 6 },
      { product_id: '502', stock: 7 },
    ]);
  });

  it('packs and receives an RTO parcel once, restocking the store only on the first receipt', async () => {
    await admin.query(
      "INSERT INTO hyperlocal_order_log (order_id, action, is_rto, delivery_exception_date, created_at, updated_at) VALUES (1001,'ACCEPTED',1,'2026-11-19 11:00:00','2026-11-19 11:00:00','2026-11-19 11:00:00')",
    );
    const actions = legacyFulfillmentActions(lifecycleRuntime(deps));
    expect(await actions.pack(operator, '1', '1001', 'Packed in bag 3')).toEqual({
      status: '200',
      message: 'RTO Order Delivered',
    });
    expect(await actions.receiveRto(operator, '1', '1001', 'Parcel back')).toMatchObject({
      alreadyRecorded: false,
    });
    expect(await actions.receiveRto(operator, '1', '1001', 'Parcel back')).toMatchObject({
      alreadyRecorded: true,
    });
    expect(await query('SELECT is_pack, rto_recieved FROM hyperlocal_order_log')).toEqual([
      { is_pack: 1, rto_recieved: 1 },
    ]);
    expect(
      await query(
        'SELECT product_id, stock FROM product_store WHERE store_id=1 ORDER BY product_id',
      ),
    ).toEqual([
      { product_id: '501', stock: 6 },
      { product_id: '502', stock: 7 },
    ]);
    expect(
      await query('SELECT store_id, pos_user_id, comment FROM pos_transaction_logs ORDER BY id'),
    ).toEqual([
      { store_id: '0', pos_user_id: '44', comment: 'Packed in bag 3, Order Packed By: Asha' },
      { store_id: '0', pos_user_id: '44', comment: 'Parcel back, RTO Package Recieved By: Asha' },
    ]);
    await expect(
      actions.status({ ...operator, storeIds: ['3'] }, '3', '1001'),
    ).rejects.toMatchObject({ status: 403 });
  });
});
