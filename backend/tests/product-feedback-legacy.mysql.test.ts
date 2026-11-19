import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../src/config.js';
import { createDatabases, type Databases } from '../src/db/pools.js';
import type { Principal } from '../src/domain/access.js';
import { bindCheckInRedis, checkInService } from '../src/modules/administration/checkins.js';
import { checkoutStateSchema } from '../src/modules/checkout/contracts.js';
import { checkoutSessionStore } from '../src/modules/checkout/session-store.js';
import { configuredStateStore } from '../src/modules/checkout/state-store.js';
import { feedbackSubmission } from '../src/modules/product-feedback/contracts.js';
import { productFeedbackService } from '../src/modules/product-feedback/service.js';
import { memoryOrderRedis } from '../src/modules/fulfillment/order-redis.js';
import { verifiedMysqlFixture } from '../tools/operational-reports/verified-mysql-fixture.js';
import { memoryRedisPort } from './helpers/memory-redis.js';
import { goldenStdout } from './golden/load.js';
import { fixturePlaceholders } from './golden/fixture-placeholders.js';

// Check-ins are the legacy Redis keys; bind an in-process port for this file.
bindCheckInRedis(memoryRedisPort());

/**
 * Pinned GetOrderFeedbackFormView.get_order / AjaxAddFeedback (users/views.py:1077-1114,
 * order/views.py:3401-3430 at 78d5b63) on genuine Django QuerySets over this native fixture,
 * replayed from tests/golden/product-feedback/native-workflow.json (captured with the d7cfa66
 * tools/product-feedback/native-workflow-source.py oracle). The browser half of that workflow
 * (Chromium over the rendered legacy page) is not captured.
 */
const integration = process.env.MYSQL_INTEGRATION_URL;
const orderId = '9007199254740993',
  productId = '10',
  customerId = '777';
const sourceFeedback = z.object({
  optionId: z.string().nullable(),
  rating: z.number().nullable(),
  platform: z.string().nullable(),
  comment: z.string().nullable(),
});
const sourceRead = z.object({
  orders: z.array(
    z.object({
      id: z.string(),
      orderAmount: z.number(),
      items: z.array(
        z.object({ productId: z.string(), name: z.string(), feedback: z.array(sourceFeedback) }),
      ),
    }),
  ),
  mainHtml: z.string(),
});
const sourceWrite = z.object({
  responses: z.array(z.object({ message: z.string(), status: z.string() })),
  nativeInserts: z.number(),
  nativeRows: z.array(z.record(z.string(), z.string().nullable())),
});
const sourceDispatch = z.object({
  status: z.number(),
  body: z.unknown(),
  location: z.string().nullable(),
  exceptionType: z.string().nullable(),
});
describe.skipIf(!integration)('pinned staff product feedback on native MySQL', () => {
  let connection: mysql.Connection, db: Databases, url: string;
  let fixture: ReturnType<typeof verifiedMysqlFixture>;
  let service: ReturnType<typeof productFeedbackService>;
  const redis = memoryOrderRedis();
  const schema = 'pos_rewrite_feedback_workflow_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const checkoutId = randomUUID();
  const user: Principal = {
    id: '7',
    role: 4,
    userType: 1,
    name: 'Fixture operator',
    email: 'operator@example.test',
    storeIds: ['1'],
  };
  const scope = { storeId: '1', checkoutId, customerId, orderId };
  // 2026-11-17 11:30:20 Asia/Kolkata; the capture froze datetime.now() at the same wall time.
  const now = Date.parse('2026-11-17T06:00:20Z');
  function source(body: Record<string, unknown>) {
    return JSON.parse(
      goldenStdout(
        'product-feedback',
        'native-workflow',
        JSON.stringify({ url, now: '2026-11-17T11:30:20', ...body }),
        undefined,
        fixturePlaceholders(url),
      ),
    ) as unknown;
  }
  async function ratings() {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT user_id,order_id,prod_id,product_rating_option_id,CAST(rating AS CHAR) AS rating,' +
        'platform,comment,is_default,parent_prod_id,is_bot,has_product_id,created_at,updated_at ' +
        'FROM product_rating_user ORDER BY id',
    );
    return rows.map((row) => ({ ...row }));
  }
  beforeAll(async () => {
    const base = new URL(integration!);
    if (
      base.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(base.hostname) ||
      base.pathname !== '/pos_rewrite_integration' ||
      base.search ||
      base.hash
    )
      throw new Error('Use only the explicit isolated local integration fixture.');
    connection = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    fixture = verifiedMysqlFixture(connection);
    await fixture.create([
      'users',
      'pos_user',
      'stores',
      'store_counters',
      'user_stores',
      'orders',
      'has_products',
      'products',
      'product_rating_user',
    ]);
    await fixture.insert('pos_user', {
      id: 7,
      role: 4,
      user_type: 1,
      username: 'fixture-operator',
      is_active: 1,
      is_staff: 1,
    });
    await fixture.insert('stores', { id: 1, type: 'STORE', is_active: 1 });
    await fixture.insert('store_counters', { id: 2, store_id: 1, is_active: 1 });
    await fixture.insert('user_stores', { django_user_id: 7, store_id: 1 });
    for (const id of [777, 778])
      await fixture.insert('users', {
        id,
        firstname: 'Fixture',
        lastname: 'Guest',
        email: `guest-${id}@example.test`,
        telephone: '987654321' + String(id).slice(-1),
        status: 1,
        is_block: 0,
        is_disabled: 0,
      });
    await fixture.insert('orders', {
      id: orderId,
      user_id: 777,
      order_amt: 125.5,
      order_status: 3,
    });
    await fixture.insert('orders', {
      id: '9007199254740994',
      user_id: 778,
      order_amt: 50,
      order_status: 3,
    });
    await fixture.insert('products', { id: productId, product: '<Fixture feedback product>' });
    await fixture.insert('products', { id: 11, product: 'Another product' });
    for (const id of ['9007199254740997', '9007199254740998'])
      await fixture.insert('has_products', { id, order_id: orderId, prod_id: productId });
    base.pathname = '/' + schema;
    url = base.href;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'product-feedback-legacy-key-'.repeat(3),
      MYSQL_WRITER_URL: url,
      MYSQL_PRIMARY_READER_URL: url,
      MYSQL_DATA_READER_URL: url,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    db = createDatabases(config);
    service = productFeedbackService(config, db, redis, () => now);
    await checkoutSessionStore(configuredStateStore(config)).write(
      checkoutStateSchema.parse({
        id: checkoutId,
        operatorId: '7',
        operatorCustomerId: '700',
        storeId: '1',
        counterId: '2',
        tabId: 1,
        customerId,
        verifiedCustomerUntil: null,
        version: 1,
        phase: 'open',
        cart: { products: { items: [] } },
        quote: null,
        orderId: null,
        paymentConfirmation: null,
        salespersonId: null,
        lineSalespersons: {},
        giftCards: {},
        busyOperationId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await checkInService(db, config).set(user, '1', '2');
  }, 30000);
  beforeEach(async () => {
    await connection.query('DELETE FROM product_rating_user');
    await redis.del([...redis.snapshot().keys()]);
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  async function compareRead(phase: string) {
    const legacy = sourceRead.parse(source({ action: 'read', phase, customerId, orderId }));
    const actual = await service.read(user, scope, {});
    expect(legacy.orders).toHaveLength(1);
    const [order] = legacy.orders;
    expect(actual.orderId).toBe(order!.id);
    expect(actual.orderAmount).toBe(order!.orderAmount);
    expect(
      actual.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        feedback: item.feedback.map(({ id: _id, ...value }) => value),
      })),
    ).toEqual(order!.items);
    return legacy;
  }
  it('reads both duplicate SKU lines with no feedback, and nothing for another customer', async () => {
    const legacy = await compareRead('empty');
    expect(legacy.orders[0]!.items).toHaveLength(2);
    expect(legacy.mainHtml).toContain('&lt;Fixture feedback product&gt;');
    expect(sourceRead.parse(source({ action: 'read', customerId: '778', orderId })).orders).toEqual(
      [],
    );
    await expect(service.read(user, { ...scope, customerId: '778' }, {})).rejects.toMatchObject({
      code: 'PRODUCT_FEEDBACK_NOT_FOUND',
    });
  });
  it('reads existing ratings of any customer/platform in the source option rotation', async () => {
    for (const [id, owner, option, rating, platform, comment] of [
      ['9007199254741001', 999, 3, null, 'IOS', 'kept'],
      ['9007199254741002', 777, 0, 4.5, 'ANDROID', 'first'],
      ['9007199254741003', 777, 2, 3, 'WEB', ''],
      ['9007199254741004', 777, 1, 0, 'WEB', null],
    ] as const)
      await fixture.insert('product_rating_user', {
        id,
        user_id: owner,
        order_id: orderId,
        prod_id: productId,
        product_rating_option_id: option,
        rating,
        platform,
        comment,
        is_default: option === 0 ? 1 : 0,
      });
    const legacy = await compareRead('seeded');
    expect(legacy.orders[0]!.items[0]!.feedback.map((value) => value.optionId)).toEqual([
      '1',
      '2',
      '3',
      '0',
    ]);
  });
  it('writes the same four native rating rows as the four source AJAX posts', async () => {
    const comment = 'café € <script>private-canary</script>';
    const legacy = sourceWrite.parse(
      source({
        action: 'write',
        submissions: ['4.5', '0', '3.2', '0'].map((rating, option) => ({
          user_id: customerId,
          order_id: orderId,
          prod_id: productId,
          product_rating_option: String(option),
          rating,
          comment: option === 0 ? comment : '',
        })),
        snapshot: { table: 'product_rating_user', column: 'order_id', values: [orderId] },
      }),
    );
    expect(legacy.responses).toEqual(
      Array.from({ length: 4 }, () => ({ message: 'Added successfully', status: '200' })),
    );
    expect(legacy.nativeInserts).toBe(4);
    // The capture wrote through Django; remove those rows before the rewrite writes its own.
    await connection.query('DELETE FROM product_rating_user');
    await service.submit(user, scope, {
      operationId: randomUUID(),
      expectedVersion: 1,
      productId,
      overall: 4.5,
      fit: 0,
      size: 3.2,
      quality: 0,
      comment,
    });
    const columns = [
      'user_id',
      'order_id',
      'prod_id',
      'product_rating_option_id',
      'rating',
      'platform',
      'comment',
      'is_default',
      'parent_prod_id',
      'is_bot',
      'has_product_id',
      'created_at',
      'updated_at',
    ] as const;
    // Both sides as MySQL text; DATETIME text is compared to the second.
    const text = (value: unknown) =>
      value === null || value === undefined ? null : String(value as string | number);
    const actual = (await ratings()).map((row) =>
      Object.fromEntries(columns.map((column) => [column, text(row[column])])),
    );
    expect(actual).toEqual(
      legacy.nativeRows.map((row) =>
        Object.fromEntries(
          columns.map((column) => {
            const value = row[column] ?? null;
            return [column, column.endsWith('_at') && value ? value.slice(0, 19) : value];
          }),
        ),
      ),
    );
  });
  it('answers an empty authenticated post with the source invalid-input body; the rewrite refuses it before writing', async () => {
    const legacy = sourceDispatch.parse(
      source({ action: 'dispatch', method: 'POST', target: '/orders/ajax-add-feedback/' }),
    );
    expect(legacy).toMatchObject({
      status: 200,
      body: { message: 'Invalid input', status: '400' },
      exceptionType: null,
    });
    expect(feedbackSubmission.safeParse({}).success).toBe(false);
    expect(await ratings()).toEqual([]);
  });
  it('redirects an unauthenticated source request to login (the rewrite answers 401)', () => {
    for (const [method, target] of [
      ['GET', `/users/order-feedback-form/${customerId}/${orderId}`],
      ['POST', '/orders/ajax-add-feedback/'],
    ] as const) {
      const legacy = sourceDispatch.parse(
        source({ action: 'dispatch', method, target, authenticated: false }),
      );
      expect(legacy.status, method).toBe(302);
      expect(legacy.location, method).toMatch(/^\/accounts\/login\/\?next=/);
    }
  });
});
