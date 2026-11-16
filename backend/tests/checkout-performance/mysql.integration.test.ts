import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { migrationPlan } from '../../src/db/migrations.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { Order, OrderStore } from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import { checkoutOperations, checkoutSessions } from '../../src/modules/checkout/schema.js';
import {
  checkoutHeaderHashSql,
  checkoutLineHashSql,
  checkoutProjectionContract,
} from '../../src/modules/checkout/projection.js';
import { customerConsentContract } from '../../src/modules/checkout/customer-consent-proof.js';
import { paymentAttemptSchema } from '../../src/modules/checkout/payments/contracts.js';
import { paymentAttempts } from '../../src/modules/checkout/payments/schema.js';
import { checkoutPerformanceService } from '../../src/modules/checkout-performance/service.js';
import { registerCheckoutPerformance } from '../../src/modules/checkout-performance/index.js';
import { registerRequestTrace } from '../../src/observability/context.js';
import { checkoutPerformanceReceipts } from '../../src/modules/checkout-performance/schema.js';
import { sourcePerformanceJson } from '../../src/modules/checkout-performance/contracts.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

describe.skipIf(!process.env.MYSQL_INTEGRATION_URL)(
  'native independent postpaid checkout timing',
  () => {
    let connection: mysql.Connection | undefined,
      db: Databases | undefined,
      config: ReturnType<typeof readConfig>,
      service: ReturnType<typeof checkoutPerformanceService>,
      fixture: ReturnType<typeof verifiedMysqlFixture>,
      schema = '';
    const checkoutId = randomUUID(),
      checkoutOperationId = randomUUID(),
      orderId = '9007199254740993',
      lineId = '9007199254740994',
      user: Principal = {
        id: '7',
        role: 4,
        userType: 1,
        storeIds: ['1'],
        name: 'Fixture operator',
        email: 'operator@example.test',
      },
      scope = { storeId: '1', checkoutId },
      performance = {
        product_main_list: '10.25',
        user_behaviour: '20.50',
        add_to_cart: '30.75',
        proceed_to_payment: '',
        overall_performance_time: 'NaN',
      },
      body = () => ({ operationId: randomUUID(), orderId, performance }),
      state = () =>
        checkoutStateSchema.parse({
          id: checkoutId,
          operatorId: user.id,
          operatorCustomerId: '777',
          storeId: '1',
          counterId: '3',
          tabId: 1,
          customerId: null,
          verifiedCustomerUntil: null,
          version: 1,
          phase: 'submitted',
          cart: { products: { items: [] } },
          quote: null,
          orderId,
          orderSubmissionOperationId: checkoutOperationId,
          paymentConfirmation: null,
          confirmationPhase: 'acknowledged',
          salespersonId: null,
          lineSalespersons: {},
          giftCards: {},
          busyOperationId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
    beforeAll(async () => {
      const url = new URL(process.env.MYSQL_INTEGRATION_URL!);
      if (
        url.protocol !== 'mysql:' ||
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_integration' ||
        url.search ||
        url.hash
      )
        throw new Error('GUARDED_LOCAL_PERFORMANCE_DATABASE_REQUIRED');
      schema =
        'pos_rewrite_checkout_performance_test_' + randomUUID().replaceAll('-', '').slice(0, 10);
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
      await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
      await connection.changeUser({ database: schema });
      fixture = verifiedMysqlFixture(connection, [
        'evidence/mysql-customer-benefit-schema.json',
        'evidence/mysql-global-benefits-schema.json',
      ]);
      await fixture.create([
        'users',
        'pos_user',
        'stores',
        'store_counters',
        'user_stores',
        'orders',
        'order_stores',
        'has_products',
        'amount_to_be_refunded_log',
        'gift_vouchers',
      ]);
      for (const migration of migrationPlan())
        for (const statement of migration.statements) await connection.query(statement);
      await connection.query(
        await readFile('src/modules/checkout-performance/migration.sql', 'utf8'),
      );
      await fixture.insert('users', { id: 777, status: 1, is_block: 0, is_disabled: 0 });
      await fixture.insert('pos_user', {
        id: 7,
        role: 4,
        user_type: 1,
        is_active: 1,
        is_staff: 1,
        username: 'fixture-operator',
      });
      await fixture.insert('stores', { id: 1, type: 'STORE', is_active: 1 });
      await fixture.insert('store_counters', { id: 3, store_id: 1, is_active: 1 });
      url.pathname = '/' + schema;
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'false',
        SESSION_SECRET: 'checkout-timing-native-'.repeat(4),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      });
      db = createDatabases(config);
      service = checkoutPerformanceService(config, db, () => Date.parse('2026-11-16T10:00:00Z'));
    }, 30000);
    beforeEach(async () => {
      for (const table of [
        'pos_rewrite_checkout_performance',
        'pos_rewrite_checkout_operations',
        'pos_rewrite_checkout_sessions',
        'pos_rewrite_payment_attempts',
        'pos_rewrite_checkout_customer_consents',
        'pos_rewrite_checkout_projection_lines',
        'pos_rewrite_checkout_projections',
        'amount_to_be_refunded_log',
        'has_products',
        'order_stores',
        'orders',
        'user_stores',
      ])
        await connection!.query('DELETE FROM ' + mysql.escapeId(table));
      await connection!.query('UPDATE pos_user SET is_active=1,role=4,user_type=1 WHERE id=7');
      await connection!.query('UPDATE users SET status=1,is_block=0,is_disabled=0 WHERE id=777');
      await fixture.insert('user_stores', { django_user_id: 7, store_id: 1 });
      await fixture.insert('orders', {
        id: orderId,
        user_id: 777,
        payment_method: 14,
        pay_amt: 100,
        payment_status: 4,
        order_status: 3,
      });
      await fixture.insert('order_stores', {
        id: '9007199254740995',
        order_id: orderId,
        store_id: 1,
        counter_id: 3,
        admin_user_id: 7,
        offline_payment: 100,
        offline_payment_recieved: 100,
        performance_json: '',
      });
      await fixture.insert('has_products', {
        id: lineId,
        order_id: orderId,
        prod_id: 10,
        qty: 1,
        price: 100,
        amount_to_be_refunded: 100,
        status: 'DELIVERED',
      });
      await fixture.insert('amount_to_be_refunded_log', {
        order_id: orderId,
        prod_id: 10,
        has_product_id: lineId,
        amount_to_be_refunded: 100,
      });
      await connection!.execute(
        `INSERT INTO pos_rewrite_checkout_projections(order_id,store_id,counter_id,user_id,input_hash,line_count,contract_version,confirmed_at) SELECT id,1,3,user_id,${checkoutHeaderHashSql},1,?,UTC_TIMESTAMP() FROM orders WHERE id=?`,
        [checkoutProjectionContract, orderId],
      );
      await connection!.execute(
        `INSERT INTO pos_rewrite_checkout_projection_lines(order_id,has_product_id,product_id,quantity,input_hash) SELECT order_id,id,prod_id,qty,${checkoutLineHashSql} FROM has_products WHERE order_id=?`,
        [orderId],
      );
      await connection!.execute(
        `INSERT INTO pos_rewrite_checkout_customer_consents(order_id,store_id,counter_id,user_id,operator_id,input_hash,required,contact_revision,contact_digest,verified_until_ms,accepted_at_ms,contract_version) SELECT id,1,3,user_id,7,${checkoutHeaderHashSql},0,NULL,NULL,NULL,1,? FROM orders WHERE id=?`,
        [customerConsentContract, orderId],
      );
      const saved = state();
      await db!
        .get('writer')
        .insert(checkoutSessions)
        .values({ id: checkoutId, operatorId: '7', storeId: '1', version: 1, state: saved });
      await db!
        .get('writer')
        .insert(checkoutOperations)
        .values({
          checkoutId,
          id: checkoutOperationId,
          status: 'succeeded',
          requestHash: 'a'.repeat(64),
          result: { state: saved, result: { orderId } },
        });
      const payment = paymentAttemptSchema.parse({
        id: randomUUID(),
        operatorId: '7',
        storeId: '1',
        counterId: '3',
        orderId,
        channel: 'cash',
        onlineAmount: '0.00',
        cashAmount: '100.00',
        cashReceived: '100.00',
        machineId: null,
        externalReference: null,
        transactionId: 'FIXTURE',
        providerReference: null,
        status: 'paid',
        requestHash: 'b'.repeat(64),
        busyOperationId: null,
        errorCode: null,
        createdAt: '2026-11-16 10:00:00',
        updatedAt: '2026-11-16 10:00:00',
      });
      await db!
        .get('writer')
        .insert(paymentAttempts)
        .values({
          id: payment.id,
          orderId,
          storeId: '1',
          operatorId: '7',
          status: 'paid',
          state: payment,
          createdAt: payment.createdAt,
          updatedAt: payment.updatedAt,
        });
      await checkInService(db!, config).set(user, '1', '3');
    });
    afterAll(async () => {
      await db?.close();
      if (connection) {
        await connection.changeUser({ database: 'mysql' });
        await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
        await connection.end();
      }
    });
    async function json() {
      const [rows] = await connection!.query<mysql.RowDataPacket[]>(
        'SELECT performance_json FROM order_stores WHERE order_id=?',
        [orderId],
      );
      return String(rows[0]?.performance_json);
    }
    it('records exact source strings for anonymous paid cash once under20 retries, without changing financial data', async () => {
      const input = body(),
        [before] = await connection!.query<mysql.RowDataPacket[]>(
          'SELECT pay_amt,payment_status,order_status,tss_money_used,tss_points_used,voucher_amt_used FROM orders WHERE id=?',
          [orderId],
        ),
        results = await Promise.all(
          Array.from({ length: 20 }, () => service.record(user, scope, input)),
        );
      expect(results.every((row) => JSON.stringify(row) === JSON.stringify(results[0]))).toBe(true);
      expect(await json()).toBe(sourcePerformanceJson(input.performance));
      expect(await db!.get('writer').select().from(checkoutPerformanceReceipts)).toHaveLength(1);
      const [after] = await connection!.query<mysql.RowDataPacket[]>(
        'SELECT pay_amt,payment_status,order_status,tss_money_used,tss_points_used,voucher_amt_used FROM orders WHERE id=?',
        [orderId],
      );
      expect(after).toEqual(before);
      expect(await service.receipt(user, scope, input.operationId)).toEqual(results[0]);
      expect((await service.read(user, scope, orderId)).receipt).toEqual(results[0]);
    }, 20000);
    it('allows proved prepaid without a payment attempt or an attached customer', async () => {
      await connection!.execute('UPDATE orders SET payment_method=3,pay_amt=0 WHERE id=?', [
        orderId,
      ]);
      await connection!.execute(
        `UPDATE pos_rewrite_checkout_projections p JOIN orders ON orders.id=p.order_id SET p.input_hash=${checkoutHeaderHashSql} WHERE orders.id=?`,
        [orderId],
      );
      await connection!.execute(
        `UPDATE pos_rewrite_checkout_customer_consents c JOIN orders ON orders.id=c.order_id SET c.input_hash=${checkoutHeaderHashSql} WHERE orders.id=?`,
        [orderId],
      );
      await db!.get('writer').delete(paymentAttempts);
      expect((await service.record(user, scope, body())).status).toBe('recorded');
    });
    it('refuses unpaid metadata without waiting for or locking a concurrent financial order transaction', async () => {
      await connection!.execute('UPDATE orders SET payment_status=1,order_status=1 WHERE id=?', [
        orderId,
      ]);
      await connection!.beginTransaction();
      await connection!.query('SELECT id FROM orders WHERE id=? FOR UPDATE', [orderId]);
      try {
        await expect(
          Promise.race([
            service.record(user, scope, body()),
            new Promise((_, reject) => {
              const timer = setTimeout(
                () => reject(new Error('Metadata waited on cash completion.')),
                1000,
              );
              timer.unref();
            }),
          ]),
        ).rejects.toMatchObject({ code: 'CHECKOUT_PERFORMANCE_NOT_READY' });
      } finally {
        await connection!.rollback();
      }
      expect(await json()).toBe('');
      expect(await db!.get('writer').select().from(checkoutPerformanceReceipts)).toEqual([]);
    });
    it('requires the original succeeded checkout frame and exact native order-store actor/customer/projection', async () => {
      await db!.get('writer').update(checkoutOperations).set({ status: 'uncertain' });
      await expect(service.record(user, scope, body())).rejects.toMatchObject({
        code: 'CHECKOUT_PERFORMANCE_NOT_READY',
      });
      await db!.get('writer').update(checkoutOperations).set({ status: 'succeeded' });
      await connection!.execute('UPDATE order_stores SET admin_user_id=8 WHERE order_id=?', [
        orderId,
      ]);
      await expect(service.record(user, scope, body())).rejects.toMatchObject({
        code: 'CHECKOUT_PERFORMANCE_UNCONFIRMED',
      });
      await connection!.execute('UPDATE order_stores SET admin_user_id=7 WHERE order_id=?', [
        orderId,
      ]);
      await connection!.execute('UPDATE orders SET pay_amt=101 WHERE id=?', [orderId]);
      await expect(service.record(user, scope, body())).rejects.toMatchObject({
        code: 'CHECKOUT_PROJECTION_UNCONFIRMED',
      });
      expect(await json()).toBe('');
    });
    it('never rewrites a changed intent, another UUID for that order or preexisting legacy metadata', async () => {
      const input = body();
      await service.record(user, scope, input);
      await expect(
        service.record(user, scope, {
          ...input,
          performance: { ...performance, add_to_cart: '1.00' },
        }),
      ).rejects.toMatchObject({ code: 'CHECKOUT_PERFORMANCE_CONFLICT' });
      await expect(service.record(user, scope, body())).rejects.toMatchObject({
        code: 'CHECKOUT_PERFORMANCE_CONFLICT',
      });
      expect(await json()).toBe(sourcePerformanceJson(performance));
    });
    it('refuses unproved cash payment flags and preserves existing legacy text', async () => {
      await db!.get('writer').delete(paymentAttempts);
      await expect(service.record(user, scope, body())).rejects.toMatchObject({
        code: 'CHECKOUT_PERFORMANCE_UNCONFIRMED',
      });
      expect(await json()).toBe('');
    });
    it('recovers the immutable receipt after later returns/contact edits while still enforcing current ownership/check-in', async () => {
      const input = body(),
        receipt = await service.record(user, scope, input);
      await connection!.execute('UPDATE orders SET order_status=6,pay_amt=1 WHERE id=?', [orderId]);
      await connection!.query(
        "UPDATE users SET email='changed@example.test',is_block=1 WHERE id=777",
      );
      expect(await service.record(user, scope, input)).toEqual(receipt);
      expect(await service.receipt(user, scope, input.operationId)).toEqual(receipt);
      await connection!.query('DELETE FROM user_stores WHERE django_user_id=7');
      await expect(service.receipt(user, scope, input.operationId)).rejects.toMatchObject({
        code: 'STORE_ACCESS_DENIED',
      });
    });
    it('returns the exact missing receipt code and rejects scope/input overrides before writes', async () => {
      await expect(service.receipt(user, scope, randomUUID())).rejects.toMatchObject({
        status: 404,
        code: 'CHECKOUT_PERFORMANCE_NOT_FOUND',
      });
      await expect(service.record(user, { ...scope, storeId: '2' }, body())).rejects.toMatchObject({
        code: 'STORE_ACCESS_DENIED',
      });
      await expect(
        service.record(user, scope, {
          ...body(),
          performance: { ...performance, comment: 'private' },
        }),
      ).rejects.toThrow();
      expect(await json()).toBe('');
    });
    it('retains existing source metadata without silently overwriting a different legacy payload', async () => {
      await db!
        .get('writer')
        .update(OrderStore)
        .set({ performance_json: '{"legacy":"keep"}' })
        .where(eq(OrderStore.order, BigInt(orderId)));
      await expect(service.record(user, scope, body())).rejects.toMatchObject({
        code: 'CHECKOUT_PERFORMANCE_CONFLICT',
      });
      expect(await json()).toBe('{"legacy":"keep"}');
      expect(await db!.get('writer').select().from(checkoutPerformanceReceipts)).toEqual([]);
    });
    it('binds an explicitly attached original customer separately from the operator-customer fallback', async () => {
      await fixture.insert('users', { id: 888, status: 1, is_block: 0, is_disabled: 0 });
      await db!
        .get('writer')
        .update(Order)
        .set({ user: 888n })
        .where(eq(Order.id, BigInt(orderId)));
      await connection!.execute(
        `UPDATE pos_rewrite_checkout_projections p JOIN orders ON orders.id=p.order_id SET p.user_id=888,p.input_hash=${checkoutHeaderHashSql} WHERE orders.id=?`,
        [orderId],
      );
      await connection!.execute(
        `UPDATE pos_rewrite_checkout_customer_consents c JOIN orders ON orders.id=c.order_id SET c.user_id=888,c.input_hash=${checkoutHeaderHashSql} WHERE orders.id=?`,
        [orderId],
      );
      const attached = { ...state(), customerId: '888' };
      await db!.get('writer').update(checkoutSessions).set({ state: attached });
      await db!
        .get('writer')
        .update(checkoutOperations)
        .set({ result: { state: attached, result: { orderId } } });
      await service.record(user, scope, body());
      expect(
        (await db!.get('writer').select().from(checkoutPerformanceReceipts))[0]?.customerId,
      ).toBe(888n);
      await connection!.query('DELETE FROM users WHERE id=888');
    });
    it('stores the exact255-byte maximum without changing the native payment/header proof', async () => {
      const maximum = {
        product_main_list: '9999999999999999.99',
        user_behaviour: '9999999999999999.99',
        add_to_cart: '9999999999999999.99',
        proceed_to_payment: '9999999999999999.99',
        fast_payment: '9999999999999999.99',
        overall_performance_time: '9007199254740991',
      };
      await service.record(user, scope, { ...body(), performance: maximum });
      expect(Buffer.byteLength(await json(), 'ascii')).toBe(255);
      expect(await json()).toBe(sourcePerformanceJson(maximum));
    });
    it('rolls metadata back if its receipt cannot commit, keeping the independently paid sale intact', async () => {
      await connection!.query(
        "CREATE TRIGGER reject_timing_fixture BEFORE INSERT ON pos_rewrite_checkout_performance FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic timing receipt failure'",
      );
      try {
        await expect(service.record(user, scope, body())).rejects.toThrow();
      } finally {
        await connection!.query('DROP TRIGGER reject_timing_fixture');
      }
      expect(await json()).toBe('');
      const [order] = await connection!.query<mysql.RowDataPacket[]>(
        'SELECT payment_status,order_status FROM orders WHERE id=?',
        [orderId],
      );
      expect(String(order[0]?.payment_status)).toBe('4');
      expect(String(order[0]?.order_status)).toBe('3');
      expect(await db!.get('writer').select().from(checkoutPerformanceReceipts)).toEqual([]);
    });
    it('preserves a full128-character request ID through the real traced HTTP route and receipt insert', async () => {
      const requestId = 't'.repeat(128),
        app = Fastify({ genReqId: () => requestId });
      app.decorateRequest('principal', null);
      app.addHook('onRequest', async (request) => {
        request.principal = user;
      });
      registerRequestTrace(app);
      registerCheckoutPerformance(app, config, db!);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/stores/1/checkout-sessions/' + checkoutId + '/performance',
          headers: { 'x-operator-id': user.id },
          payload: body(),
        });
        expect(response.statusCode).toBe(200);
        expect(
          (await db!.get('writer').select().from(checkoutPerformanceReceipts))[0]?.requestId,
        ).toBe(requestId);
      } finally {
        await app.close();
      }
    });
  },
);
