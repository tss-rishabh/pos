import mysql from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { eq } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  ExpressLineItem,
  ExpressOrderStatusLog,
  HasProduct,
  HyperlocalRejectionReason,
  Notification,
  Order,
  OrderStatus,
  PaymentStatus,
  Product,
  PosUser,
  UserStore,
  Store,
  UsersNotification,
} from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import { fulfillmentService } from '../../src/modules/fulfillment/service.js';
import { fulfillmentEffects } from '../../src/modules/fulfillment/effects.js';
import { redisCheckIns } from '../../src/modules/fulfillment/checkin.js';
import { memoryOrderRedis } from '../../src/modules/fulfillment/order-redis.js';
import { readFulfillmentOptions } from '../../src/modules/fulfillment/options.js';
import { autoRejectTimedOutForStore } from '../../src/modules/fulfillment/expiry.js';
import { createOrderNotification } from '../../src/modules/fulfillment/notifications.js';
import { fulfillmentMonitoring } from '../../src/modules/fulfillment/monitoring.js';

const connection = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!connection)('fulfillment lifecycle on isolated local MySQL', () => {
  const schema = `pos_rewrite_fulfillment_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const models = [
    ExpressLineItem,
    ExpressOrderStatusLog,
    HasProduct,
    HyperlocalRejectionReason,
    Notification,
    Order,
    OrderStatus,
    PaymentStatus,
    Product,
    PosUser,
    UserStore,
    Store,
    UsersNotification,
  ];
  const user: Principal = {
    id: '900001',
    name: 'Fixture operator',
    email: 'fixture@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1'],
  };
  const clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
  const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'fulfillment-local-fixture-'.repeat(3),
  });
  let admin: mysql.Connection | undefined,
    databases: Databases | undefined,
    created = false;
  const options = {
    ...readFulfillmentOptions({}),
    BACKEND_SYNC_API_BASE_URL: 'https://sync.example.test',
    BACKEND_SYNC_REPO_API_KEY: 'fixture-sync-key',
    MJML_HOST: 'https://mailr.example.test/',
    PREORDER_URL: 'https://preorder.example.test/',
    PREORDER_INTERNAL_KEY: 'fixture-preorder-key',
    MAIN_API_V2_URL: 'https://api-v2.example.test/',
    SLACK_URL: 'https://hooks.slack.com/services/common',
  };
  /** Every outbound request, with the express line statuses visible at the moment it was sent. */
  const calls: { url: string; body: unknown; statuses: string[] }[] = [];
  const responses = new Map<string, string>();
  let redis = memoryOrderRedis();
  const published: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const [rows] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT status FROM express_line_item WHERE store_id=1 ORDER BY id',
    );
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as unknown,
      statuses: rows.map((row) => String(row.status)),
    });
    return new Response(responses.get(String(input)) ?? '{}', { status: 200 });
  };
  function harness() {
    const effects = fulfillmentEffects(db(), options, { fetch: fetcher }),
      checkins = redisCheckIns(redis);
    return {
      effects,
      checkins,
      service: fulfillmentService(config, db(), options, { checkins, effects, clock }),
      expiry: { config, db: db(), options, redis, effects, clock },
      notifications: {
        config,
        db: db(),
        checkins,
        effects,
        clock,
        bus: {
          publish: async (event: unknown) => {
            published.push(event);
          },
        },
      },
    };
  }
  const urls = () => calls.map((call) => call.url);
  function db() {
    if (!databases) throw new Error('Fixture not initialized');
    return databases;
  }
  async function insert(model: MySqlTable, overrides: Record<string, string | number | null>) {
    const cfg = getTableConfig(model);
    const known = new Set(cfg.columns.map((column) => column.name));
    if (Object.keys(overrides).some((key) => !known.has(key)))
      throw new Error('Fixture overrides contain an unmapped column.');
    const columns = cfg.columns.filter(
      (column) =>
        !('autoIncrement' in column && column.autoIncrement && !(column.name in overrides)),
    );
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
    if (!['127.0.0.1', 'localhost'].includes(url.hostname))
      throw new Error('Fulfillment fixtures require a local MySQL host.');
    admin = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    created = true;
    await admin.changeUser({ database: schema });
    for (const model of models) {
      const cfg = getTableConfig(model);
      const columns = cfg.columns.map(
        (column) =>
          mysql.escapeId(column.name) +
          ' ' +
          column.getSQLType() +
          (column.notNull ? ' NOT NULL' : ' NULL') +
          ('autoIncrement' in column && column.autoIncrement ? ' AUTO_INCREMENT' : '') +
          (column.primary ? ' PRIMARY KEY' : ''),
      );
      await admin.query(
        `CREATE TABLE ${mysql.escapeId(cfg.name)} (${columns.join(',')}) ENGINE=InnoDB`,
      );
    }
    url.pathname = '/' + schema;
    databases = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'fulfillment-mysql-local-'.repeat(3),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  });
  beforeEach(async () => {
    for (const model of models)
      await admin!.query(`TRUNCATE TABLE ${mysql.escapeId(getTableConfig(model).name)}`);
    redis = memoryOrderRedis();
    await redis.set(`check_in_${user.id}`, '[1, "Fixture store"]');
    redis.lPush('check_in_list_1', user.id);
    calls.length = 0;
    responses.clear();
    await insert(Store, {
      id: 1,
      store_name: 'Fixture store',
      is_active: 1,
      type: 'STORE',
      slack_group_url: 'https://hooks.slack.com/services/store-1',
    });
    await insert(Store, { id: 2, store_name: 'Other store', is_active: 1, type: 'STORE' });
    await insert(PosUser, { id: Number(user.id), is_active: 1, role: 4, user_type: 1 });
    await insert(UserStore, { django_user_id: Number(user.id), store_id: 1 });
    await insert(Product, { id: 101, product: 'Fixture tee' });
    await insert(Order, {
      id: 1001,
      order_ref_no: 'FIXTURE-1001',
      first_name: 'Fixture',
      created_at: '2026-11-16 10:00:00',
    });
    for (const [id, status, storeId] of [
      [501, 'PENDING', 1],
      [502, 'PENDING', 1],
      [503, 'PENDING', 2],
    ] as const) {
      await insert(HasProduct, {
        id,
        order_id: 1001,
        prod_id: 101,
        qty: 1,
        pre_gst_amt: 100,
        gst: 5,
        status: 'PLACED',
        shipment_id: 'SAMPLE-SHIPMENT',
        awb: 'SAMPLE-AWB',
      });
      await insert(ExpressLineItem, {
        id: id - 400,
        order_id: 1001,
        store_id: storeId,
        has_product_id: id,
        status,
        pending_expires_at: '2026-11-16 14:00:00',
        accepted_expires_at: '2026-11-16 16:00:00',
        vinc_status: 'Allocated',
      });
    }
    await insert(HyperlocalRejectionReason, { id: 1, reason: 'Fixture reason', is_active: 1 });
  });
  afterAll(async () => {
    await databases?.close();
    if (admin && created) {
      await admin.changeUser({ database: 'mysql' });
      await admin.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
    }
    await admin?.end();
  });
  const lineStatuses = async () => {
    const [rows] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT id, store_id, status, rejection_reason_id FROM express_line_item ORDER BY id',
    );
    return rows.map((row) => [Number(row.id), String(row.status), row.rejection_reason_id]);
  };
  const logs = async () => {
    const [rows] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT order_id, store_id, old_status, new_status FROM express_order_status_log ORDER BY id',
    );
    return rows.map(
      (row) => `${row.order_id}/${row.store_id}:${row.old_status}->${row.new_status}`,
    );
  };

  it('keeps notification IDs above the safe integer boundary and creates O5 notices for checked-in users', async () => {
    const first = '9007199254740993',
      second = '9007199254740994';
    for (const id of [first, second]) {
      await insert(Notification, {
        id,
        store_id: 1,
        order_id: 1001,
        title: 'Fixture notification',
      });
      await insert(UsersNotification, {
        notification_id: id,
        pos_admin_id: Number(user.id),
        is_viewed: 0,
      });
    }
    const { service, notifications } = harness();
    const rows = await service.notifications(user, '1', first);
    expect(rows.data.map((row) => row.id)).toEqual([second]);
    expect(rows.unreadCount).toBe(2);
    await service.markNotificationRead(user, '1', second);
    expect((await service.notifications(user, '1')).unreadCount).toBe(1);
    await redis.set(`check_in_${user.id}`, '[2, "Other store"]');
    await expect(service.markNotificationRead(user, '1', first)).rejects.toMatchObject({
      code: 'CHECK_IN_REQUIRED',
    });
    const created = await createOrderNotification(notifications, {
      title: 'Hyperlocal Order',
      orderId: '1001',
      storeId: '1',
      isSlack: true,
      isNewOrder: true,
      sendToCommon: false,
    });
    expect(created?.notificationId).toBe('9007199254740995');
    const [notice] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT title FROM pos_notifications WHERE id=?',
      ['9007199254740995'],
    );
    expect(notice[0]?.title).toBe('Hyperlocal Order to Fixture store');
    const [targets] = await admin!.query<mysql.RowDataPacket[]>(
      'SELECT pos_admin_id FROM pos_user_notifications WHERE notification_id=?',
      ['9007199254740995'],
    );
    expect(targets.map((row) => String(row.pos_admin_id))).toEqual([user.id]);
    expect(calls).toEqual([
      expect.objectContaining({
        url: 'https://hooks.slack.com/services/store-1',
        body: expect.objectContaining({
          text: '🛵 Order Id: 1001, Hyperlocal Order to Fixture store',
        }),
      }),
    ]);
    expect(published).toContainEqual({
      event: 'notification.created',
      notificationId: '9007199254740995',
      storeId: '1',
      userIds: [user.id],
      isNewOrder: true,
    });
  });

  it('accepts only this store’s pending lines and writes the legacy log, deltas and alert', async () => {
    const { service, effects } = harness();
    const result = await service.accept(user, '1', '1001');
    await effects.idle();
    expect(result).toEqual({ message: 'Success', updatedCount: 2 });
    expect(await lineStatuses()).toEqual([
      [101, 'ACCEPTED', null],
      [102, 'ACCEPTED', null],
      [103, 'PENDING', null],
    ]);
    expect(await logs()).toEqual(['1001/1:PENDING->ACCEPTED']);
    expect(calls.map((call) => [call.url, call.body])).toEqual(
      expect.arrayContaining([
        [
          'https://preorder.example.test/express-delivery/concurrency-sync',
          { storeId: 1, pending: -2, accepted: 2 },
        ],
        [
          'https://hooks.slack.com/services/store-1',
          expect.objectContaining({
            text: '✅ Hyperlocal Order ID: 1001 Accepted at Fixture store',
          }),
        ],
      ]),
    );
    // A repeat accept matches legacy: nothing moves, but the log row is written again.
    expect((await service.accept(user, '1', '1001')).updatedCount).toBe(0);
    expect(await logs()).toHaveLength(2);
    await admin!.query('DELETE FROM user_stores WHERE django_user_id=?', [user.id]);
    await expect(service.accept(user, '1', '1001')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
  });

  it('enforces the legacy card guards before any write', async () => {
    const { service } = harness();
    await admin!.query("UPDATE express_line_item SET vinc_status='' WHERE id=101");
    await expect(service.accept(user, '1', '1001')).rejects.toMatchObject({
      code: 'FULFILLMENT_AWAITING_ALLOCATION',
    });
    await admin!.query(
      "UPDATE express_line_item SET vinc_status='Allocated', pending_expires_at='2026-11-16 13:00:00' WHERE id=101",
    );
    await expect(service.reject(user, '1', '1001', '1')).rejects.toMatchObject({
      code: 'FULFILLMENT_ACCEPTANCE_EXPIRED',
    });
    await admin!.query(
      "UPDATE express_line_item SET status='ACCEPTED', pending_expires_at='2026-11-16 14:00:00' WHERE store_id=1",
    );
    await expect(service.reject(user, '1', '1001', '1')).rejects.toMatchObject({
      code: 'FULFILLMENT_REJECT_AFTER_ACCEPTANCE',
    });
    await admin!.query("UPDATE has_products SET shipment_id='0' WHERE id IN (501, 502)");
    await expect(service.pack(user, '1', '1001')).rejects.toMatchObject({
      code: 'FULFILLMENT_AWAITING_SHIPMENT_ID',
    });
    await admin!.query("UPDATE has_products SET shipment_id='S1', awb='' WHERE id IN (501, 502)");
    await admin!.query("UPDATE express_line_item SET status='PACKED' WHERE store_id=1");
    await expect(service.ship(user, '1', '1001')).rejects.toMatchObject({
      code: 'FULFILLMENT_AWAITING_AWB',
    });
    expect(await logs()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('rejects with an active reason and converts to a warehouse order after commit', async () => {
    const { service } = harness();
    await expect(service.reject(user, '1', '1001', '9')).rejects.toMatchObject({
      code: 'INVALID_REJECTION_REASON',
    });
    responses.set('https://api-v2.example.test/express-to-warehouse-order', '{"order": 7777}');
    expect(await service.reject(user, '1', '1001', '1')).toEqual({
      message: 'Success',
      updatedCount: 2,
    });
    expect(await lineStatuses()).toEqual([
      [101, 'REJECTED', 1],
      [102, 'REJECTED', 1],
      [103, 'PENDING', null],
    ]);
    expect(calls[0]).toMatchObject({
      url: 'https://api-v2.example.test/express-to-warehouse-order',
      body: { order_id: 1001, has_product_ids: [501, 502] },
      statuses: ['REJECTED', 'REJECTED'],
    });
    expect(calls[1]?.body).toMatchObject({
      text: '❌ Hyperlocal Order ID: 1001 Rejected at Fixture store — Converted to online order | New Order ID: 7777 | Reason: Fixture reason | SKUs: [101, 101]',
    });
  });

  it('packs, ships (session and courier) and marks RTO with the legacy side-effect order', async () => {
    const { service, effects } = harness();
    await service.accept(user, '1', '1001');
    await effects.idle();
    calls.length = 0;
    expect((await service.pack(user, '1', '1001')).updatedCount).toBe(2);
    await effects.idle();
    // Legacy posts PACK before its own update (`order/views.py:5059`).
    expect(calls[0]).toMatchObject({
      url: 'https://sync.example.test/order/status',
      body: { orderId: '1001', has_product_ids: ['501', '502'], platform: 'PACK' },
      statuses: ['ACCEPTED', 'ACCEPTED'],
    });
    expect(urls()).toContain('https://preorder.example.test/express-delivery/concurrency-sync');
    expect(await logs()).toEqual(['1001/1:PENDING->ACCEPTED', '1001/1:ACCEPTED->PACKED']);
    calls.length = 0;
    expect(await service.shipFromCourier('1001', 'UNKNOWN')).toBeNull();
    const shipped = await service.shipFromCourier('1001', 'SAMPLE-AWB');
    expect(shipped).toEqual({ message: 'Success', updatedCount: 2 });
    expect(calls.map((call) => [call.url, call.body])).toEqual([
      [
        'https://sync.example.test/order/status',
        { orderId: '1001', has_product_ids: ['501', '502'], platform: 'SHIP' },
      ],
      [
        'https://mailr.example.test/api/v2/mailr/express-order/out-for-delivery/',
        { order_id: '1001', awb: 'SAMPLE-AWB' },
      ],
      [
        'https://hooks.slack.com/services/store-1',
        expect.objectContaining({
          text: '🚚 Hyperlocal Order ID: 1001 Shipped from Fixture store | SKUs: [101, 101]',
        }),
      ],
    ]);
    const [order] = await db().get('writer').select().from(Order);
    expect(order?.order_statuses).toBe(26n);
    await expect(service.ship(user, '1', '1001')).rejects.toMatchObject({
      code: 'FULFILLMENT_STATE_CONFLICT',
    });
    await expect(service.rto(user, '1', '1001')).rejects.toMatchObject({
      code: 'RTO_NOT_RECEIVED',
    });
    await admin!.query("UPDATE has_products SET status='RTO_DELIVERED' WHERE order_id=1001");
    calls.length = 0;
    expect((await service.rto(user, '1', '1001')).updatedCount).toBe(2);
    expect(calls[0]).toMatchObject({
      url: 'https://sync.example.test/order/rto',
      body: { orderId: '1001', has_product_ids: ['501', '502'] },
    });
  });

  it('packs a single accepted line as AjaxExpressLineItemPackView does', async () => {
    const { service, effects } = harness();
    await service.accept(user, '1', '1001');
    await effects.idle();
    calls.length = 0;
    expect(await service.packLine(user, '1', '1001', '101')).toEqual({
      message: 'Success',
      updatedCount: 1,
    });
    await effects.idle();
    await expect(service.packLine(user, '1', '1001', '101')).rejects.toMatchObject({
      code: 'FULFILLMENT_STATE_CONFLICT',
    });
    expect(calls.map((call) => call.body)).toEqual([{ storeId: 1, accepted: -1 }]);
  });

  it('runs O1 under the legacy lock: rejects allocated, times out the rest, auto-packs and retries allocation', async () => {
    const { expiry } = harness();
    await admin!.query(
      "UPDATE express_line_item SET pending_expires_at='2026-11-16 13:00:00' WHERE store_id=1",
    );
    await insert(Order, { id: 1002, first_name: 'Second', created_at: '2026-11-16 10:00:00' });
    await insert(Order, { id: 1003, first_name: 'Third', created_at: '2026-11-16 10:00:00' });
    await insert(HasProduct, { id: 504, order_id: 1002, prod_id: 101, qty: 1, status: 'PLACED' });
    await insert(HasProduct, { id: 505, order_id: 1003, prod_id: 101, qty: 1, status: 'PLACED' });
    await insert(ExpressLineItem, {
      id: 104,
      order_id: 1002,
      store_id: 1,
      has_product_id: 504,
      status: 'PENDING',
      pending_expires_at: '2026-11-16 13:00:00',
      vinc_status: '',
    });
    await insert(ExpressLineItem, {
      id: 105,
      order_id: 1003,
      store_id: 1,
      has_product_id: 505,
      status: 'ACCEPTED',
      accepted_expires_at: '2026-11-16 13:00:00',
      vinc_status: '',
    });
    await redis.set('express_reject_lock:1', 'other-run', { EX: 300 });
    expect(await autoRejectTimedOutForStore(expiry, '1')).toBe('skipped-locked');
    expect(await lineStatuses()).toContainEqual([101, 'PENDING', null]);
    await redis.del(['express_reject_lock:1']);
    expect(await autoRejectTimedOutForStore(expiry, '1')).toBe('completed');
    expect(await redis.get('express_reject_lock:1')).toBeNull();
    expect(await lineStatuses()).toEqual([
      [101, 'REJECTED', 5],
      [102, 'REJECTED', 5],
      [103, 'PENDING', null],
      [104, 'TIMED_OUT', 5],
      [105, 'PACKED', null],
    ]);
    expect(await logs()).toEqual([
      '1001/1:PENDING->REJECTED',
      '1002/1:PENDING->TIMED_OUT',
      '1003/1:ACCEPTED->PACKED',
    ]);
    // The conversion API runs before the rejection is written (`order/tasks.py:112-115`).
    expect(calls[0]).toMatchObject({
      url: 'https://api-v2.example.test/express-to-warehouse-order',
      statuses: ['PENDING', 'PENDING', 'PENDING', 'ACCEPTED'],
    });
    expect(urls()).toContain('https://sync.example.test/order/status');
    calls.length = 0;
    await admin!.query("UPDATE express_line_item SET vinc_status='Allocated' WHERE id=104");
    await autoRejectTimedOutForStore(expiry, '1');
    expect((await lineStatuses())[3]).toEqual([104, 'REJECTED', 5]);
    expect((await logs()).at(-1)).toBe('1002/1:TIMED_OUT->REJECTED');
    // 🔺 alert, then the deferred conversion and its own success alert (`order/tasks.py:207-217`).
    expect(urls()).toEqual([
      'https://hooks.slack.com/services/store-1',
      'https://api-v2.example.test/express-to-warehouse-order',
      'https://hooks.slack.com/services/store-1',
    ]);
  });

  it('serves progress for the Redis check-in store with legacy card facts and Load More', async () => {
    const { service } = harness();
    const progress = await service.progress(user);
    expect(progress).toMatchObject({
      storeId: '1',
      tabCounts: { in_queue: 1, not_packed: 0, packed: 0, shipped: 0 },
      orderIds: { in_queue: ['1001'] },
    });
    const page = await service.progressOrders(user, 'in_queue', 0);
    expect(page).toMatchObject({ storeId: '1', hasMore: false, orderIds: ['1001'] });
    expect(page.data[0]).toMatchObject({
      id: '1001',
      customerName: 'Fixture ',
      expiresAt: '2026-11-16 14:00:00',
      isVincAllocated: true,
      hasShipmentId: true,
      hasAwb: true,
      storeOrderAmount: 210,
    });
    expect(page.data[0]?.lines.map((line) => line.id)).toEqual(['101', '102']);
    await redis.del([`check_in_${user.id}`]);
    expect((await service.progress(user)).storeId).toBeNull();
  });

  it('reads the all-stores monitor from MySQL with legacy store scope, date swap and packed timers', async () => {
    const monitor = fulfillmentMonitoring(config, db(), redisCheckIns(redis), clock),
      input = {
        from: '2026-11-16',
        to: '2026-11-16',
        tab: 'in_queue' as const,
        page: 99,
        pageSize: 10 as const,
      },
      viewer = { role: user.role, storeIds: user.storeIds, checkedInStore: null };
    expect(await monitor.defaults(user)).toMatchObject({
      from: '2026-11-16',
      to: '2026-11-16',
      storeIds: ['1'],
    });
    const scoped = await monitor.read({ ...input, storeIds: ['1'] }, viewer);
    expect(scoped.tabCounts.in_queue).toBe(1);
    expect(scoped.page).toBe(1);
    expect(scoped.data[0]?.lines).toHaveLength(2);
    expect(scoped.data[0]?.storeOrderAmount).toBe(210);
    const all = await monitor.read({ ...input, from: '2026-11-17', to: '2026-11-15' }, viewer);
    expect(all.total).toBe(2);
    expect(all.data.every((row) => row.isSplit)).toBe(true);
    // S24: names only for assigned/checked-in stores; role 1 sees every store.
    expect(all.data.map((row) => [row.storeId, row.customerName]).sort()).toEqual([
      ['1', 'Fixture'],
      ['2', 'F*****e'],
    ]);
    const checkedIn = await monitor.read(
      { ...input, from: undefined, to: undefined },
      { ...viewer, checkedInStore: '2' },
    );
    expect(checkedIn.data.every((row) => row.customerName === 'Fixture')).toBe(true);
    const roleOne = await monitor.read(
      { ...input, from: undefined, to: undefined },
      { role: 1, storeIds: [], checkedInStore: null },
    );
    expect(roleOne.total).toBe(2);
    expect(roleOne.data.every((row) => row.customerName === 'Fixture')).toBe(true);
    expect((await monitor.stores()).data.map((store) => store.id)).toEqual(['1', '2']);
    await db()
      .get('writer')
      .update(ExpressLineItem)
      .set({ status: 'PACKED', updated_at: '2026-11-16 12:00:00' })
      .where(eq(ExpressLineItem.store_id, 1));
    await insert(ExpressOrderStatusLog, {
      order_id: 1001,
      store_id: 1,
      old_status: 'ACCEPTED',
      new_status: 'PACKED',
      changed_at: '2026-11-16 13:00:00',
    });
    const packed = await monitor.read({ ...input, tab: 'packed', storeIds: ['1'] }, viewer);
    expect(packed.data[0]?.packedAt).toBe('2026-11-16 13:00:00');
    expect(packed.data[0]?.packedSeconds).toBe(1800);
  });

  it('lets only role 1 edit express lines, logging each changed status', async () => {
    const { service } = harness();
    await expect(service.edit(user, '1', '1001', { status: 'ACCEPTED' })).rejects.toMatchObject({
      code: 'ROLE_ACCESS_DENIED',
    });
    await admin!.query('UPDATE pos_user SET role=1, user_type=2 WHERE id=?', [user.id]);
    await admin!.query('DELETE FROM user_stores WHERE django_user_id=?', [user.id]);
    const admin1 = { ...user, role: 1 as const, userType: 2 as const, storeIds: [] };
    expect(
      await service.edit(admin1, '2', '1001', {
        status: 'ACCEPTED',
        acceptedExpiresAt: '2026-11-16T18:30',
      }),
    ).toEqual({ success: true, updatedCount: 1 });
    expect(await logs()).toEqual(['1001/2:PENDING->ACCEPTED']);
    await admin!.query('UPDATE pos_user SET is_active=0 WHERE id=?', [user.id]);
    await expect(service.edit(admin1, '1', '1001', { status: 'PENDING' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
});
