import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import { checkoutSessionStore } from '../../src/modules/checkout/session-store.js';
import { memoryStateStore } from '../../src/modules/checkout/state-store.js';
import { checkoutPerformanceService } from '../../src/modules/checkout-performance/service.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

describe.skipIf(!process.env.MYSQL_INTEGRATION_URL)(
  'legacy order_stores.performance_json for the sale order',
  () => {
    let connection: mysql.Connection | undefined,
      db: Databases | undefined,
      schema = '';
    const checkoutId = randomUUID(),
      orderId = '9007199254740993',
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
      };
    const stateStore = memoryStateStore(),
      sessions = checkoutSessionStore(stateStore);
    beforeAll(async () => {
      const url = new URL(process.env.MYSQL_INTEGRATION_URL!);
      if (url.protocol !== 'mysql:' || !['localhost', '127.0.0.1'].includes(url.hostname))
        throw new Error('GUARDED_LOCAL_PERFORMANCE_DATABASE_REQUIRED');
      schema = 'pos_rewrite_checkout_performance_' + randomUUID().replaceAll('-', '').slice(0, 10);
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
      const fixture = verifiedMysqlFixture(connection);
      await fixture.create(['order_stores']);
      await fixture.insert('order_stores', { id: 1, order_id: orderId, store_id: 1 });
      await fixture.insert('order_stores', { id: 2, order_id: orderId, store_id: 1 });
      await fixture.insert('order_stores', { id: 3, order_id: 5, store_id: 1 });
      url.pathname = '/' + schema;
      db = createDatabases(
        readConfig({
          NODE_ENV: 'test',
          SESSION_SECRET: 'performance-native-fixture-'.repeat(3),
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
          MYSQL_WRITER_URL: url.href,
          MYSQL_PRIMARY_READER_URL: url.href,
        }),
      );
      await sessions.write(
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
          orderSubmissionOperationId: randomUUID(),
          paymentConfirmation: null,
          salespersonId: null,
          lineSalespersons: {},
          giftCards: {},
          busyOperationId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    });
    afterAll(async () => {
      await db?.close();
      await connection?.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
      await connection?.end();
    });

    it('writes json.dumps output to every order_stores row of the sale order and replays by operation', async () => {
      const service = checkoutPerformanceService(db!, { stateStore, sessions }),
        operationId = randomUUID(),
        receipt = await service.record(user, scope, { operationId, orderId, performance });
      expect(receipt).toMatchObject({ operationId, checkoutId, orderId, status: 'recorded' });
      const [rows] = await connection!.query<mysql.RowDataPacket[]>(
        'SELECT id, performance_json FROM order_stores ORDER BY id',
      );
      const expected =
        '{"product_main_list": "10.25", "user_behaviour": "20.50", "add_to_cart": "30.75", "proceed_to_payment": "", "overall_performance_time": "NaN"}';
      expect(rows.map((row) => row.performance_json)).toEqual([expected, expected, '']);
      expect(await service.record(user, scope, { operationId, orderId, performance })).toEqual(
        receipt,
      );
      expect(await service.receipt(user, scope, operationId)).toEqual(receipt);
      await expect(
        service.record(user, scope, {
          operationId,
          orderId,
          performance: { ...performance, add_to_cart: '1.00' },
        }),
      ).rejects.toMatchObject({ status: 409, code: 'CHECKOUT_PERFORMANCE_CONFLICT' });
      await expect(
        service.record(user, scope, { operationId: randomUUID(), orderId: '5', performance }),
      ).rejects.toMatchObject({ status: 409, code: 'CHECKOUT_PERFORMANCE_ORDER_MISMATCH' });
      await expect(
        service.record({ ...user, id: '8' }, scope, {
          operationId: randomUUID(),
          orderId,
          performance,
        }),
      ).rejects.toMatchObject({ status: 404, code: 'CHECKOUT_NOT_FOUND' });
      await expect(service.receipt(user, scope, randomUUID())).rejects.toMatchObject({
        status: 404,
        code: 'CHECKOUT_PERFORMANCE_NOT_FOUND',
      });
    });
  },
);
