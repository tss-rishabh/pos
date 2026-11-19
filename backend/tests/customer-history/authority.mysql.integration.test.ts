import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { bindCheckInRedis, checkInService } from '../../src/modules/administration/checkins.js';
import { memoryRedisPort } from '../../src/redis/memory.js';

import { checkoutStateSchema, type CheckoutState } from '../../src/modules/checkout/contracts.js';
import { checkoutSessionStore } from '../../src/modules/checkout/session-store.js';
import { configuredStateStore } from '../../src/modules/checkout/state-store.js';
import { customerHistoryService } from '../../src/modules/customer-history/service.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
// Check-ins are the legacy Redis keys; bind an in-process port for this file.
bindCheckInRedis(memoryRedisPort());

describe.skipIf(!process.env.MYSQL_INTEGRATION_URL)(
  'customer-history writer capture around external reads',
  () => {
    let connection: mysql.Connection | undefined,
      db: Databases | undefined,
      config: ReturnType<typeof readConfig>,
      schema = '';
    const checkoutId = randomUUID(),
      user: Principal = {
        id: '44',
        role: 4,
        userType: 1,
        name: 'Fixture',
        email: 'fixture@example.test',
        storeIds: ['1'],
      },
      scope = { storeId: '1', checkoutId };
    const state = () =>
      checkoutStateSchema.parse({
        id: checkoutId,
        operatorId: '44',
        operatorCustomerId: '44',
        storeId: '1',
        counterId: '2',
        tabId: 1,
        customerId: '7',
        verifiedCustomerUntil: null,
        version: 1,
        phase: 'open',
        cart: { products: { items: [] } },
        quote: null,
        orderId: null,
        orderSubmissionOperationId: null,
        paymentConfirmation: null,
        salespersonId: null,
        lineSalespersons: {},
        giftCards: {},
        busyOperationId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    const result = () => ({
      summary: {
        exclusiveSavings: 0,
        totalOrders: '0',
        totalStoreOrders: '0',
        totalOnlineOrders: '0',
        last30DaysOrders: '0',
        cancelledOrders: '0',
        returnedOrders: '0',
        npsScore: null,
      },
      recentOrders: [],
      returnedRows: [],
    });
    beforeAll(async () => {
      const url = new URL(process.env.MYSQL_INTEGRATION_URL!);
      if (
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_integration'
      )
        throw new Error('GUARDED_LOCAL_CUSTOMER_AUTHORITY_REQUIRED');
      schema =
        'pos_rewrite_customer_history_scope_test_' + randomUUID().replaceAll('-', '').slice(0, 12);
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
      await fixture.create(['users', 'pos_user', 'stores', 'store_counters', 'user_stores']);
      await fixture.insert('users', { id: 7, status: 1, is_block: 0 });
      await fixture.insert('pos_user', {
        id: 44,
        role: 4,
        user_type: 1,
        is_active: 1,
        is_staff: 1,
        username: 'fixture-operator',
      });
      await fixture.insert('stores', { id: 1, type: 'STORE', is_active: 1 });
      await fixture.insert('store_counters', { id: 2, store_id: 1, is_active: 1 });
      await fixture.insert('user_stores', { django_user_id: 44, store_id: 1 });
      url.pathname = '/' + schema;
      config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'false',
        SESSION_SECRET: 'customer-history-native-scope-'.repeat(3),
        MYSQL_WRITER_URL: url.href,
        MYSQL_PRIMARY_READER_URL: url.href,
        MYSQL_DATA_READER_URL: url.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      });
      db = createDatabases(config);
    }, 20000);
    // The sale lives in the Redis checkout session store (memory store: no REDIS_URL).
    const writeSale = (value: CheckoutState) =>
      checkoutSessionStore(configuredStateStore(config)).write(value);
    beforeEach(async () => {
      await connection!.query('UPDATE pos_user SET is_active=1 WHERE id=44');
      await connection!.query('UPDATE users SET status=1,is_block=0 WHERE id=7');
      await writeSale(state());
      await checkInService(db!, config).set(user, '1', '2');
    });
    afterAll(async () => {
      await db?.close();
      if (connection) {
        await connection.changeUser({ database: 'mysql' });
        await connection.query('DROP DATABASE ' + mysql.escapeId(schema));
        await connection.end();
      }
    });
    it('releases SQL authority locks before HTTP and rejects a writer-current operator revocation afterward', async () => {
      let reads = 0;
      const service = customerHistoryService(config, db!, {
        gateway: {
          async read() {
            reads++;
            await connection!.query({
              sql: 'UPDATE pos_user SET is_active=0 WHERE id=44',
              timeout: 1000,
            });
            return result();
          },
          async lines() {
            throw new Error('Unexpected lines.');
          },
        },
      });
      let failure: unknown;
      try {
        await service.read(user, scope, {});
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AppError);
      expect([401, 403]).toContain((failure as AppError).status);
      expect(reads).toBe(1);
    });
    it('rejects customer blocking and checkout version changes during the external read', async () => {
      const blocked = customerHistoryService(config, db!, {
        gateway: {
          async read() {
            await connection!.query({
              sql: 'UPDATE users SET is_block=1 WHERE id=7',
              timeout: 1000,
            });
            return result();
          },
          async lines() {
            throw new Error('Unexpected lines.');
          },
        },
      });
      await expect(blocked.read(user, scope, {})).rejects.toMatchObject({
        code: 'CUSTOMER_PROFILE_NOT_FOUND',
      });
      await connection!.query('UPDATE users SET is_block=0 WHERE id=7');
      const changed = customerHistoryService(config, db!, {
        gateway: {
          async read() {
            await writeSale({ ...state(), version: 2 });
            return result();
          },
          async lines() {
            throw new Error('Unexpected lines.');
          },
        },
      });
      await expect(changed.read(user, scope, {})).rejects.toMatchObject({
        code: 'CUSTOMER_HISTORY_CONTEXT_CHANGED',
      });
    });
  },
);
