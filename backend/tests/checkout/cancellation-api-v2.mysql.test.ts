import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig, type Config } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import {
  apiV2CancelPosOrderClient,
  cancelPosOrderBody,
  cancelPosOrderUrl,
  type CancelPosOrderClient,
} from '../../src/modules/checkout/cancellations/api-v2.js';
import {
  cancelRefundPayDict,
  cancellationLockKey,
  pendingCancellationRepository,
} from '../../src/modules/checkout/cancellations/repository.js';
import { executeStockProcedure } from '../../src/modules/administration/stock-procedure.js';
import { memoryStateStore } from '../../src/modules/checkout/state-store.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const operator: Principal = {
  id: '44',
  name: 'Cashier',
  email: 'cashier@example.test',
  role: 3,
  userType: 1,
  storeIds: ['1'],
};

describe('API-v2 cancel-pos-order wire format', () => {
  it('posts the legacy body and only a Content-Type header to the legacy base URL', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: URL, init: RequestInit) => {
      calls.push({ url: url.href, init });
      return new Response('{"message": "refund on order cancel"}', { status: 200 });
    }) as unknown as typeof fetch;
    const config = {
      NODE_ENV: 'test',
      TSS_API_BASE_URL: 'https://fallback.example.test/',
      TSS_API_MIGRATION_V2: true,
    } as const;
    const target = cancelPosOrderUrl(config, {
      mainApiV2Url: 'https://main.example.test/api/v2/',
      apiV2Url: 'https://old.example.test/',
    })!;
    expect(target.href).toBe('https://main.example.test/api/v2/pos/cancel-pos-order');
    expect(
      cancelPosOrderUrl({ ...config, TSS_API_MIGRATION_V2: false }, { apiV2Url: 'https://o.test/' })
        ?.href,
    ).toBe('https://o.test/pos/cancel-pos-order');
    const outcome = await apiV2CancelPosOrderClient(target, fetcher).cancel({
      userId: '9007199254740993',
      orderId: '77',
    });
    expect(outcome).toEqual({ accepted: true, body: { message: 'refund on order cancel' } });
    expect(calls[0]?.init.body).toBe('{"user_id": 9007199254740993, "order_id": 77}');
    expect(calls[0]?.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(cancelPosOrderBody('1', '2')).toBe('{"user_id": 1, "order_id": 2}');
    expect(cancelRefundPayDict(0, 12.5, 0)).toBe(
      "{'tss point refunded': 0.0, 'tss money refunded': 12.5, 'gift voucher amount refunded': 0.0}",
    );
  });
});

describe.skipIf(!template)('pending order cancellation against unpatched API-v2', () => {
  let connection: mysql.Connection, db: Databases, config: Config, schema: string;
  beforeAll(async () => {
    const url = new URL(template!);
    if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('Explicit isolated localhost MySQL required.');
    schema = `pos_rewrite_cancel_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection);
    await fixture.create([
      'pos_user',
      'stores',
      'user_stores',
      'orders',
      'order_stores',
      'has_products',
      'order_status',
      'payment_status',
      'pos_transaction_logs',
      'amount_to_be_refunded_log',
      'product_store',
    ]);
    await connection.query(
      'CREATE TABLE inventory_calls (store_id BIGINT, product_id BIGINT, stock INT, admin BIGINT, comment VARCHAR(255))',
    );
    await connection.query(
      'CREATE PROCEDURE pos_stock_syncer(IN s BIGINT, IN p BIGINT, IN st INT, IN u BIGINT, IN a BIGINT, IN c VARCHAR(255)) INSERT INTO inventory_calls VALUES (s,p,st,a,c)',
    );
    await fixture.insert('pos_user', { id: 44, role: 3, is_active: 1, user_type: 1 });
    await fixture.insert('stores', { id: 1, category: 'COCO' });
    await fixture.insert('user_stores', { id: 1, django_user_id: 44, store_id: 1 });
    await fixture.insert('order_status', { id: 1, order_status: 'Order Placed' });
    await fixture.insert('order_status', { id: 4, order_status: 'CANCELLED' });
    await fixture.insert('payment_status', { id: 1, payment_status: 'Pending' });
    await fixture.insert('payment_status', { id: 2, payment_status: 'Cancelled' });
    url.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'isolated-cancellation-secret-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    db = createDatabases(config);
  });
  afterAll(async () => {
    await db?.close();
    await connection?.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
    await connection?.end();
  });
  async function order(id: number, lines: { id: number; product: number; qty: number }[]) {
    const fixture = verifiedMysqlFixture(connection);
    await fixture.insert('orders', {
      id,
      user_id: 501,
      payment_method: 14,
      payment_status: 1,
      order_status: 1,
    });
    await fixture.insert('order_stores', { id, order_id: id, store_id: 1, counter_id: 3 });
    for (const line of lines) {
      await fixture.insert('has_products', {
        id: line.id,
        order_id: id,
        prod_id: line.product,
        qty: line.qty,
        status: 'PLACED',
      });
      await fixture.insert('amount_to_be_refunded_log', {
        order_id: id,
        prod_id: line.product,
        tss_money_used: line.id % 2 ? 12.5 : 0,
        has_product_id: line.id,
      });
    }
  }
  const rows = async (query: string, values: unknown[] = []) =>
    (await connection.query<mysql.RowDataPacket[]>(query, values))[0];

  it('cancels a pending order through a fake API-v2 and applies the legacy local writes', async () => {
    await order(900, [
      { id: 9001, product: 10, qty: 2 },
      { id: 9002, product: 10, qty: 3 },
      { id: 9003, product: 12, qty: 1 },
    ]);
    await connection.query(
      'INSERT INTO product_store (id, product_id, store_id, stock, is_avail, is_del) VALUES (1, 10, 1, 10, 1, 0)',
    );
    const calls: { userId: string; orderId: string }[] = [],
      synced: string[][] = [];
    const client: CancelPosOrderClient = {
      cancel: async (input) => {
        calls.push(input);
        return { accepted: true, body: { message: 'refund on order cancel' } };
      },
    };
    const state = memoryStateStore(),
      service = pendingCancellationRepository(db, config, {
        stateStore: state,
        client,
        stockProcedure: executeStockProcedure,
        syncProducts: async (_id, ids) => {
          synced.push(ids);
        },
      });
    expect(await service.context(operator, '1', '900')).toEqual({
      orderId: '900',
      storeId: '1',
      eligible: true,
    });
    expect(await service.create(operator, '1', '900')).toEqual({
      orderId: '900',
      storeId: '1',
      status: 'cancelled',
      message: 'Order Cancel request processed.',
    });
    expect(calls).toEqual([{ userId: '501', orderId: '900' }]);
    expect(
      await rows('SELECT payment_status, order_status FROM orders WHERE id=900'),
    ).toMatchObject([{ payment_status: 2, order_status: 4 }]);
    expect(
      (await rows('SELECT status FROM has_products WHERE order_id=900')).map((r) => r.status),
    ).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
    expect(
      await rows(
        'SELECT order_status, payment_status, user_id, pos_user_id, pay_dict, comment FROM pos_transaction_logs WHERE order_id=900 ORDER BY id',
      ),
    ).toEqual([
      {
        order_status: '4',
        payment_status: '2',
        user_id: '0',
        pos_user_id: '44',
        pay_dict: '{}',
        comment: 'Order Cancelled : No Transaction Made',
      },
      {
        order_status: '4',
        payment_status: '2',
        user_id: '0',
        pos_user_id: '44',
        pay_dict:
          "{'tss point refunded': 0.0, 'tss money refunded': 12.5, 'gift voucher amount refunded': 0.0}",
        comment: 'Order cancel refund for Product id: 10',
      },
      {
        order_status: '4',
        payment_status: '2',
        user_id: '0',
        pos_user_id: '44',
        pay_dict:
          "{'tss point refunded': 0.0, 'tss money refunded': 12.5, 'gift voucher amount refunded': 0.0}",
        comment: 'Order cancel refund for Product id: 10',
      },
      {
        order_status: '4',
        payment_status: '2',
        user_id: '0',
        pos_user_id: '44',
        pay_dict:
          "{'tss point refunded': 0.0, 'tss money refunded': 12.5, 'gift voucher amount refunded': 0.0}",
        comment: 'Order cancel refund for Product id: 12',
      },
    ]);
    // Legacy `.first()` refund row repeats for a duplicate SKU (helpers/helpers.py:473).
    // Golden oracle "duplicate-sku": per-line restoration 10 -> 12 -> 15; missing association skipped.
    expect(await rows('SELECT stock FROM product_store WHERE id=1')).toEqual([{ stock: 15 }]);
    expect(
      (await rows('SELECT stock, admin, comment FROM inventory_calls ORDER BY stock')).map((r) => [
        r.stock,
        r.admin,
        r.comment,
      ]),
    ).toEqual([
      [12, '44', 'Product inventory added from admin panel on order cancel, [Order ID:900]'],
      [15, '44', 'Product inventory added from admin panel on order cancel, [Order ID:900]'],
    ]);
    expect(synced).toEqual([['10'], ['10']]);
    expect((await service.context(operator, '1', '900')).eligible).toBe(false);
    await expect(service.create(operator, '1', '900')).rejects.toMatchObject({
      status: 409,
      code: 'ORDER_NOT_CANCELLABLE',
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse((await state.get(cancellationLockKey('900')))!)).toMatchObject({
      status: 'cancelled',
    });
  });

  it('changes nothing locally when API-v2 refuses, and releases the order for a retry', async () => {
    await order(901, [{ id: 9101, product: 10, qty: 1 }]);
    const state = memoryStateStore(),
      service = pendingCancellationRepository(db, config, {
        stateStore: state,
        client: { cancel: async () => ({ accepted: false, status: 400 }) },
        stockProcedure: executeStockProcedure,
      });
    await expect(service.create(operator, '1', '901')).rejects.toMatchObject({
      status: 409,
      code: 'ORDER_CANCEL_REJECTED',
    });
    expect(await rows('SELECT order_status FROM orders WHERE id=901')).toEqual([
      { order_status: 1 },
    ]);
    expect(await rows('SELECT id FROM pos_transaction_logs WHERE order_id=901')).toEqual([]);
    expect(await state.get(cancellationLockKey('901'))).toBeNull();
  });

  it('refuses another store, a missing order and an unconfigured API-v2 before calling it', async () => {
    const service = pendingCancellationRepository(db, config, {
      stateStore: memoryStateStore(),
      stockProcedure: executeStockProcedure,
    });
    await expect(service.create(operator, '1', '901')).rejects.toMatchObject({ status: 503 });
    const configured = pendingCancellationRepository(db, config, {
      stateStore: memoryStateStore(),
      client: {
        cancel: () => {
          throw new Error('must not be called');
        },
      },
      stockProcedure: executeStockProcedure,
    });
    await expect(configured.create(operator, '2', '901')).rejects.toMatchObject({ status: 403 });
    await expect(configured.create(operator, '1', '999')).rejects.toMatchObject({ status: 404 });
  });
});
