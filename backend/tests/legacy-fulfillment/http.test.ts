import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { memoryOrderRedis } from '../../src/modules/fulfillment/order-redis.js';
import type { LegacyFulfillmentActions } from '../../src/modules/legacy-fulfillment/actions.js';
import { registerLegacyFulfillment } from '../../src/modules/legacy-fulfillment/index.js';

const user: Principal = {
  id: '44',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
function harness() {
  const app = Fastify();
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request) => {
    request.principal = user;
  });
  app.setErrorHandler((error, _request, reply) => {
    void reply
      .status(error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .send({ error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' } });
  });
  const db: Databases = {
    get: () => {
      throw new Error('Unexpected database use.');
    },
    close: async () => {},
  };
  const lifecycle = {
    arrival: vi.fn(async () => {}),
    webhookCancel: vi.fn(async () => ({ ok: true, error: {} })),
  };
  const actions = {
    lifecycle,
    status: vi.fn(async () => ({ orderId: '1001' })),
    pack: vi.fn(async () => ({ status: '200', message: 'RTO Order Delivered' })),
    receiveRto: vi.fn(),
    create: vi.fn(),
    cancel: vi.fn(),
    pass: vi.fn(async () => ({ status: '200', operation: 'transfer', message: 'ok' })),
    convert: vi.fn(),
  } as unknown as LegacyFulfillmentActions;
  registerLegacyFulfillment(
    app,
    readConfig({
      NODE_ENV: 'test',
      MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
      SESSION_SECRET: 'legacy-http-fixture-'.repeat(4),
    }),
    db,
    {
      actions,
      redis: memoryOrderRedis(),
      dependencies: {
        environment: {
          APP_ID: 'app',
          APP_KEY: 'app-key',
          TSS_OBERVER_APP_ID: 'obs',
          TSS_OBERVER_APP_KEY: 'obs-key',
        },
        publish: async () => {},
      },
    },
  );
  return { app, actions, lifecycle };
}
const form = { 'content-type': 'application/x-www-form-urlencoded' };

describe('legacy fulfillment HTTP contracts', () => {
  it('serves AutoHlOrderView at both legacy mounts with APPID/APPKEY and the legacy bodies', async () => {
    const { app, lifecycle } = harness();
    try {
      for (const prefix of ['/orders', '/api/v1/orders']) {
        const denied = await app.inject({
          method: 'POST',
          url: prefix + '/auto-hl-order/',
          headers: { ...form, appid: 'app', appkey: 'wrong' },
          payload: 'order_id=12&location_id=4&is_notify=1',
        });
        expect(denied.statusCode).toBe(401);
        expect(denied.json()).toEqual({ status: '401', message: 'Authentication Failed' });
      }
      const accepted = await app.inject({
        method: 'POST',
        url: '/orders/auto-hl-order/',
        headers: { ...form, APPID: 'app', APPKEY: 'app-key' },
        payload: 'order_id=12&location_id=4&is_notify=0',
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ status: '200', message: 'Order Creation is in progress' });
      // Django request.POST.get('is_notify') is truthy for any non-empty value, including "0".
      expect(lifecycle.arrival).toHaveBeenCalledWith('12', '4', true);
      await app.inject({
        method: 'POST',
        url: '/api/v1/orders/auto-hl-order/',
        headers: { ...form, appid: 'app', appkey: 'app-key' },
        payload: 'order_id=13&location_id=4',
      });
      expect(lifecycle.arrival).toHaveBeenLastCalledWith('13', '4', false);
    } finally {
      await app.close();
    }
  });
  it('serves WebhookCancelledOrderView with the observer credentials and the literal legacy message', async () => {
    const { app, lifecycle } = harness();
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/orders/webhook-cancelled-order/',
        headers: { ...form, appid: 'app', appkey: 'app-key' },
        payload: 'order_id=12&store_id=4&platform=rto',
      });
      expect(denied.statusCode).toBe(401);
      const accepted = await app.inject({
        method: 'POST',
        url: '/orders/webhook-cancelled-order/',
        headers: { ...form, appid: 'obs', appkey: 'obs-key' },
        payload: 'order_id=12&store_id=4&platform=rto&is_notify=true&title=Order%20RTO',
      });
      expect(accepted.json()).toEqual({
        status: '200',
        message: 'Order cancelled/refund: {resp} {error_msg}',
      });
      expect(lifecycle.webhookCancel).toHaveBeenCalledWith({
        orderId: '12',
        storeId: '4',
        platform: 'rto',
        notify: true,
        title: 'Order RTO',
      });
      const duplicate = await app.inject({
        method: 'POST',
        url: '/orders/webhook-cancelled-order/',
        headers: { ...form, appid: 'obs', appkey: 'obs-key' },
        payload: 'order_id=12&order_id=13&store_id=4',
      });
      expect(duplicate.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('validates operator routes before any action runs', async () => {
    const { app, actions } = harness();
    try {
      const base = '/api/v1/stores/1/legacy-fulfillment/orders/1001';
      const stale = await app.inject({
        method: 'GET',
        url: base,
        headers: { 'x-operator-id': '45' },
      });
      expect(stale.statusCode).toBe(409);
      const empty = await app.inject({
        method: 'PUT',
        url: base + '/packing',
        headers: { 'x-operator-id': '44' },
        payload: { note: '  ' },
      });
      expect(empty.statusCode).toBe(400);
      const transfer = await app.inject({
        method: 'POST',
        url: '/api/v1/stores/1/local-deliveries/orders/1001/transfers',
        headers: { 'x-operator-id': '44' },
        payload: { reason: 'Rush hour', reasonDropdown: 'Not a legacy reason' },
      });
      expect(transfer.statusCode).toBe(400);
      expect(actions.pass).not.toHaveBeenCalled();
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/stores/1/local-deliveries/orders/1001/transfers',
        headers: { 'x-operator-id': '44' },
        payload: { reason: 'Rush hour', reasonDropdown: 'Printer not available at store' },
      });
      expect(accepted.statusCode).toBe(200);
      expect(actions.pass).toHaveBeenCalledWith(
        user,
        '1',
        '1001',
        'Rush hour',
        'Printer not available at store',
      );
    } finally {
      await app.close();
    }
  });
});
