import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { createDatabases, type Databases } from '../src/db/pools.js';
import { Order, PosUser, Store } from '../src/db/legacy-schema.js';
import type { Principal } from '../src/domain/access.js';
import { AppError } from '../src/domain/errors.js';
import { registerRequestTrace } from '../src/observability/context.js';
import { bindCheckInRedis, checkInService } from '../src/modules/administration/checkins.js';
import { memoryRedisPort } from './helpers/memory-redis.js';

import { checkoutStateSchema } from '../src/modules/checkout/contracts.js';
import { checkoutSessionStore } from '../src/modules/checkout/session-store.js';
import { configuredStateStore } from '../src/modules/checkout/state-store.js';
import { benefitCustomers } from '../src/modules/customer-insights/benefits-schema.js';
import { productFeedbackService } from '../src/modules/product-feedback/service.js';
import { productRatings } from '../src/modules/product-feedback/schema.js';
import { feedbackReceiptKey } from '../src/modules/product-feedback/service.js';
import { memoryOrderRedis } from '../src/modules/fulfillment/order-redis.js';
import { verifiedMysqlFixture } from '../tools/operational-reports/verified-mysql-fixture.js';
import { injectWriteFailure } from './helpers/production-schema.js';
// Check-ins are the legacy Redis keys; bind an in-process port for this file.
bindCheckInRedis(memoryRedisPort());

const integration = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!integration)('native staff feedback atomicity and current scope', () => {
  let connection: mysql.Connection,
    db: Databases,
    service: ReturnType<typeof productFeedbackService>;
  let fixture: ReturnType<typeof verifiedMysqlFixture>;
  let config: ReturnType<typeof readConfig>;
  const redis = memoryOrderRedis();
  const schema =
    'pos_rewrite_product_feedback_test_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const checkoutId = randomUUID(),
    orderId = '9007199254740993',
    productId = '9007199254740995';
  const user: Principal = {
    id: '7',
    role: 4,
    userType: 1,
    name: 'Fixture operator',
    email: 'operator@example.test',
    storeIds: ['1'],
  };
  const scope = { storeId: '1', checkoutId, customerId: '777', orderId };
  const state = (id = checkoutId) =>
    checkoutStateSchema.parse({
      id,
      operatorId: '7',
      operatorCustomerId: '700',
      storeId: '1',
      counterId: '2',
      tabId: 1,
      customerId: '777',
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
    });
  const input = () => ({
    operationId: randomUUID(),
    expectedVersion: 1,
    productId,
    overall: 4.5,
    fit: 0,
    size: 3.2,
    quality: 0,
    comment: 'café € <script>private-canary</script>',
  });
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
    await fixture.insert('users', {
      id: 777,
      firstname: 'Fixture',
      lastname: 'Guest',
      email: 'guest@example.test',
      telephone: '9876543210',
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
    await fixture.insert('products', { id: productId, product: '<Fixture product>' });
    await fixture.insert('has_products', {
      id: '9007199254740997',
      order_id: orderId,
      prod_id: productId,
    });
    await fixture.insert('has_products', {
      id: '9007199254740998',
      order_id: orderId,
      prod_id: productId,
    });
    base.pathname = '/' + schema;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'product-feedback-native-key-'.repeat(3),
      MYSQL_WRITER_URL: base.href,
      MYSQL_PRIMARY_READER_URL: base.href,
      MYSQL_DATA_READER_URL: base.href,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    });
    db = createDatabases(config);
    const actual = productFeedbackService(config, db, redis);
    function sanitized(cause: unknown): never {
      if (cause instanceof AppError) throw cause;
      const diagnostic = cause as { name?: string; code?: string; cause?: { code?: string } };
      throw new Error(
        'Native feedback fixture failed: ' +
          JSON.stringify({
            name: diagnostic.name,
            code: diagnostic.code,
            causeCode: diagnostic.cause?.code,
          }),
      );
    }
    service = {
      read: (...args) => actual.read(...args).catch(sanitized),
      submit: (...args) => actual.submit(...args).catch(sanitized),
      receipt: (...args) => actual.receipt(...args).catch(sanitized),
    };
  }, 30000);
  beforeEach(async () => {
    await connection.query('DELETE FROM product_rating_user');
    await redis.del([...redis.snapshot().keys()]);
    await db
      .get('writer')
      .update(Order)
      .set({ user: 777n, order_statuses: 3n })
      .where(eq(Order.id, BigInt(orderId)));
    await db
      .get('writer')
      .update(benefitCustomers)
      .set({ active: 1, blocked: 0, disabled: 0 })
      .where(eq(benefitCustomers.id, 777n));
    await db.get('writer').update(PosUser).set({ is_active: true }).where(eq(PosUser.id, 7n));
    await db.get('writer').update(Store).set({ is_active: true }).where(eq(Store.id, 1n));
    // The sale lives in the Redis checkout session store (memory store: no REDIS_URL).
    await checkoutSessionStore(configuredStateStore(config)).write(state());
    await checkInService(db, config).set(user, '1', '2');
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  it('retains duplicate SKU lines, source rotation, null/partial ratings and exact keyset pages', async () => {
    const empty = await service.read(user, scope, { limit: 1 });
    expect(empty.items).toHaveLength(1);
    expect(empty.nextCursor).toBe('9007199254740997');
    expect(
      (await service.read(user, scope, { after: empty.nextCursor, limit: 1 })).items[0]?.lineId,
    ).toBe('9007199254740998');
    await fixture.insert('product_rating_user', {
      id: '9007199254741001',
      user_id: 999,
      order_id: orderId,
      prod_id: productId,
      product_rating_option_id: 0,
      rating: null,
      comment: 'kept',
      platform: 'IOS',
    });
    await fixture.insert('product_rating_user', {
      id: '9007199254741002',
      user_id: 777,
      order_id: orderId,
      prod_id: productId,
      product_rating_option_id: 2,
      rating: 3,
      platform: 'ANDROID',
    });
    const read = await service.read(user, scope, {});
    expect(read.items.map((line) => line.productId)).toEqual([productId, productId]);
    expect(read.items[0]?.feedback.map((row) => [row.id, row.optionId, row.rating])).toEqual([
      ['9007199254741002', '2', 3],
      ['9007199254741001', '0', null],
    ]);
    expect(read.items[0]?.feedback).toEqual(read.items[1]?.feedback);
    await expect(service.submit(user, scope, input())).rejects.toMatchObject({
      code: 'PRODUCT_FEEDBACK_ALREADY_EXISTS',
    });
    expect(redis.snapshot().size).toBe(0);
  });
  it('20 concurrent exact retries create one receipt and four exact source rows without PII in the receipt', async () => {
    const command = input();
    // The replay receipt is written to Redis after the MySQL commit (schema freeze), so a retry
    // racing that commit may see the saved rows first; legacy had no dedupe at all.
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => service.submit(user, scope, command)),
    );
    const results = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(
      settled
        .filter((result) => result.status === 'rejected')
        .every(
          (result) =>
            (result.reason as { code?: string }).code === 'PRODUCT_FEEDBACK_ALREADY_EXISTS',
        ),
    ).toBe(true);
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    const rows = await db
      .get('writer')
      .select()
      .from(productRatings)
      .orderBy(productRatings.optionId);
    expect(
      rows.map((row) => [
        row.customerId,
        row.orderId,
        row.productId,
        row.optionId,
        row.rating,
        row.platform,
        row.comment,
        row.isDefault,
      ]),
    ).toEqual(
      [0, 1, 2, 3].map((option) => [
        777n,
        BigInt(orderId),
        BigInt(productId),
        BigInt(option),
        [4.5, 0, 3.2, 0][option],
        'WEB',
        option === 0 ? command.comment : '',
        option === 0 ? 1 : 0,
      ]),
    );
    expect(rows.every((row) => row.createdAt === row.updatedAt)).toBe(true);
    const receipt = await service.receipt(user, scope, command.operationId);
    expect(receipt).toEqual(results[0]);
    expect(receipt.ratingIds).toEqual(rows.map((row) => String(row.id)));
    expect(redis.snapshot().get(feedbackReceiptKey(command.operationId))).not.toContain(
      'private-canary',
    );
    await expect(service.submit(user, scope, { ...command, overall: 2 })).rejects.toMatchObject({
      code: 'PRODUCT_FEEDBACK_OPERATION_REUSED',
    });
  }, 20000);
  it('saves all ratings and the replay receipt under a full 128-character request trace', async () => {
    const requestId = 'request_' + 'x'.repeat(120),
      command = input();
    const app = Fastify({ logger: false, genReqId: () => requestId });
    registerRequestTrace(app);
    app.post(
      '/feedback-fixture',
      {
        config: {
          trace: { module: 'product-feedback', resource: 'product-feedback', action: 'create' },
        },
      },
      async () => service.submit(user, scope, command),
    );
    try {
      const response = await app.inject({ method: 'POST', url: '/feedback-fixture' });
      expect(response.statusCode).toBe(200);
      const saved = JSON.parse(redis.snapshot().get(feedbackReceiptKey(command.operationId))!) as {
        receipt: { ratingIds: string[] };
      };
      expect(saved.receipt.ratingIds).toHaveLength(4);
      expect(await db.get('writer').select().from(productRatings)).toHaveLength(4);
    } finally {
      await app.close();
    }
  });
  it('serializes different operations and separate checkouts on the same order without a legacy unique index', async () => {
    const second = randomUUID();
    await checkoutSessionStore(configuredStateStore(config)).write(state(second));
    const results = await Promise.allSettled([
      service.submit(user, scope, input()),
      service.submit(user, { ...scope, checkoutId: second }, input()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason as unknown),
    ).toMatchObject([{ code: 'PRODUCT_FEEDBACK_ALREADY_EXISTS' }]);
    expect(await db.get('writer').select().from(productRatings)).toHaveLength(4);
  });
  it('rolls all four rows and the receipt back when a native final-option insert fails', async () => {
    const restore = await injectWriteFailure(connection, {
      table: 'product_rating_user',
      event: 'INSERT',
      message: 'fixture',
      when: { column: 'product_rating_option_id', equals: 3 },
    });
    try {
      await expect(service.submit(user, scope, input())).rejects.toBeDefined();
    } finally {
      await restore();
    }
    expect(await db.get('writer').select().from(productRatings)).toHaveLength(0);
    expect(redis.snapshot().size).toBe(0);
  });
  it('rejects another operator, customer, product, order, stale checkout and non-delivered order', async () => {
    await expect(service.read({ ...user, id: '8' }, scope, {})).rejects.toMatchObject({
      code: 'CUSTOMER_PROFILE_NOT_FOUND',
    });
    await expect(service.read(user, { ...scope, customerId: '778' }, {})).rejects.toMatchObject({
      code: 'PRODUCT_FEEDBACK_NOT_FOUND',
    });
    await expect(service.read(user, { ...scope, orderId: '99' }, {})).rejects.toMatchObject({
      code: 'PRODUCT_FEEDBACK_NOT_FOUND',
    });
    await expect(
      service.submit(user, scope, { ...input(), productId: '11' }),
    ).rejects.toMatchObject({ code: 'PRODUCT_FEEDBACK_NOT_FOUND' });
    await expect(
      service.submit(user, scope, { ...input(), expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: 'PRODUCT_FEEDBACK_SALE_CHANGED' });
    await db
      .get('writer')
      .update(Order)
      .set({ order_statuses: 4n })
      .where(eq(Order.id, BigInt(orderId)));
    expect((await service.read(user, scope, {})).editable).toBe(false);
    await expect(service.submit(user, scope, input())).rejects.toMatchObject({
      code: 'PRODUCT_FEEDBACK_ORDER_NOT_DELIVERED',
    });
  });
  it.each(['blocked', 'disabled'] as const)(
    'refuses fresh reads and saves for a currently %s customer',
    async (field) => {
      await db
        .get('writer')
        .update(benefitCustomers)
        .set({ [field]: 1 })
        .where(eq(benefitCustomers.id, 777n));
      await expect(service.read(user, scope, {})).rejects.toMatchObject({
        code: 'PRODUCT_FEEDBACK_NOT_FOUND',
      });
      await expect(service.submit(user, scope, input())).rejects.toMatchObject({
        code: 'PRODUCT_FEEDBACK_NOT_FOUND',
      });
    },
  );
  it('rechecks archived operators/stores even with a cached principal', async () => {
    await db.get('writer').update(PosUser).set({ is_active: false }).where(eq(PosUser.id, 7n));
    await expect(service.read(user, scope, {})).rejects.toBeDefined();
    await db.get('writer').update(PosUser).set({ is_active: true }).where(eq(PosUser.id, 7n));
    await db.get('writer').update(Store).set({ is_active: false }).where(eq(Store.id, 1n));
    await expect(service.submit(user, scope, input())).rejects.toBeDefined();
  });
});
