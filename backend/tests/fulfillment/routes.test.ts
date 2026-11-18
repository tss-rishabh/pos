import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import type { EnqueueOptions, JobArgs, JobName, JobProducer } from '../../src/jobs/contract.js';
import { registerFulfillment } from '../../src/modules/fulfillment/index.js';
import type { NotificationBus } from '../../src/modules/fulfillment/notification-bus.js';
import { readFulfillmentOptions } from '../../src/modules/fulfillment/options.js';
import { memoryOrderRedis } from '../../src/modules/fulfillment/order-redis.js';
import type { FulfillmentService } from '../../src/modules/fulfillment/service.js';

const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'fulfillment-route-test-secret-'.repeat(2),
});
const credentials = readFulfillmentOptions({
  APP_ID: 'fixture-app',
  APP_KEY: 'fixture-app-key',
  EXPRESS_ORDER_API_KEY: 'fixture-courier-key',
});
const user: Principal = {
  id: '900001',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
const db: Databases = {
  get: () => {
    throw new Error('Unexpected DB call');
  },
  close: async () => {},
};
const bus: NotificationBus = {
  publish: async () => {},
  subscribe: async () => async () => {},
  close: async () => {},
};
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});
async function setup(withJobs = true) {
  const enqueued: { name: JobName; args: JobArgs; options: EnqueueOptions }[] = [],
    shipped: [string, string][] = [];
  const jobs: JobProducer = {
    async enqueue(name, args, options) {
      enqueued.push({ name, args, options });
      return { jobId: crypto.randomUUID(), name, queue: options.queue, dueAt: 0 };
    },
  };
  const service = {
    checkInStore: async () => '7',
    progress: async () => ({ storeId: '7', tabCounts: {}, orderIds: {} }),
    progressOrders: async (_user: Principal, tab: string, offset: number) => ({
      storeId: '7',
      tab,
      offset,
    }),
    shipFromCourier: async (orderId: string, awb: string) => {
      shipped.push([orderId, awb]);
      if (awb === 'NONE') return null;
      if (awb === 'DONE')
        throw new AppError(409, 'FULFILLMENT_STATE_CONFLICT', 'No packed items found');
      return { message: 'Success' as const, updatedCount: 2 };
    },
  } as unknown as FulfillmentService;
  app = Fastify({ logger: false });
  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (request) => {
    if (request.headers.cookie === 'fixture-session') request.principal = user;
  });
  await registerFulfillment(app, config, db, {
    redis: memoryOrderRedis(),
    bus,
    credentials,
    service,
    ...(withJobs ? { jobs } : {}),
  });
  await app.ready();
  return { app, enqueued, shipped };
}
describe('fulfillment legacy webhooks and progress triggers', () => {
  it('accepts the legacy new-order notify body and queues O5 per store on queue order', async () => {
    const fixture = await setup();
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/orders/ajax-express-order-notify/',
      headers: { appid: 'fixture-app', appkey: 'fixture-app-key' },
      payload: { order_id: 1001, store_ids: [3, '4'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: '200', message: 'Notification queued' });
    expect(fixture.enqueued).toEqual(
      ['3', '4'].map((storeId) => ({
        name: 'order.views.advance_order_notification',
        args: {
          title: 'Hyperlocal Order',
          order_id: '1001',
          store_id: storeId,
          is_slack: true,
          is_new_order: true,
          send_to_common: false,
        },
        options: { queue: 'order' },
      })),
    );
    const headers = { appid: 'fixture-app', appkey: 'fixture-app-key' };
    const invalid = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/orders/ajax-express-order-notify/',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ status: '400', message: 'Invalid JSON' });
    const missing = await fixture.app.inject({
      method: 'POST',
      url: '/orders/ajax-express-order-notify/',
      headers,
      payload: { order_id: 1001, store_ids: [] },
    });
    expect(missing.json()).toEqual({
      status: '400',
      message: 'order_id and store_ids are required',
    });
  });
  it('refuses a notify it cannot queue instead of dropping it', async () => {
    const fixture = await setup(false);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/orders/ajax-express-order-notify/',
      headers: { appid: 'fixture-app', appkey: 'fixture-app-key' },
      payload: { order_id: 1001, store_ids: [3] },
    });
    expect(response.statusCode).toBe(503);
  });
  it('accepts the courier form body with the apikey header and keeps the legacy reply shape', async () => {
    const fixture = await setup();
    const post = (payload: string) =>
      fixture.app.inject({
        method: 'POST',
        url: '/orders/ship-express-order/',
        headers: {
          apikey: 'fixture-courier-key',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload,
      });
    expect((await post('order_id=1001&awb=AWB-1')).json()).toEqual({
      message: 'Success',
      status: '200',
      updated_count: 2,
    });
    expect((await post('order_id=1001')).json()).toEqual({
      message: 'Invalid request',
      status: '400',
    });
    expect((await post('order_id=1001&awb=NONE')).json()).toEqual({
      message: 'Could not resolve store for order/awb',
      status: '400',
    });
    expect((await post('order_id=1001&awb=DONE')).json()).toEqual({
      message: 'No packed items found',
      status: '400',
    });
    expect(fixture.shipped).toEqual([
      ['1001', 'AWB-1'],
      ['1001', 'NONE'],
      ['1001', 'DONE'],
    ]);
  });
  it('enqueues O1 for the check-in store on progress and content views but not on Load More', async () => {
    const fixture = await setup();
    const get = (url: string) =>
      fixture.app.inject({ url, headers: { cookie: 'fixture-session' } });
    expect((await get('/api/v1/fulfillment/progress?tab=packed')).json()).toMatchObject({
      storeId: '7',
      pollIntervalMs: 100000,
    });
    await get('/api/v1/fulfillment/progress/orders?tab=bogus');
    expect((await get('/api/v1/fulfillment/progress/orders?offset=20')).json()).toMatchObject({
      tab: 'in_queue',
      offset: 20,
    });
    expect(fixture.enqueued).toEqual([
      {
        name: 'order.tasks.auto_reject_timed_out_for_store',
        args: { store_id: '7' },
        options: { queue: 'order' },
      },
      {
        name: 'order.tasks.auto_reject_timed_out_for_store',
        args: { store_id: '7' },
        options: { queue: 'order' },
      },
    ]);
  });
});
