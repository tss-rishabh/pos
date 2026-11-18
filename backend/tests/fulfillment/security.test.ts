import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Databases } from '../../src/db/pools.js';
import { readConfig } from '../../src/config.js';
import { AppError } from '../../src/domain/errors.js';
import type { Principal } from '../../src/domain/access.js';
import { registerFulfillment } from '../../src/modules/fulfillment/index.js';
import type { NotificationBus } from '../../src/modules/fulfillment/notification-bus.js';
import { readFulfillmentOptions } from '../../src/modules/fulfillment/options.js';

const user: Principal = {
  id: '900001',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'fulfillment-security-test-secret-'.repeat(2),
});
const credentials = readFulfillmentOptions({
  APP_ID: 'fixture-app',
  APP_KEY: 'fixture-service-secret-'.repeat(2),
});
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});
async function setup(subscription?: {
  ready: Promise<void>;
  started: () => void;
  completed: () => void;
}) {
  let databaseCalls = 0,
    stillValid = true;
  let checkedInStore: string | null = '1';
  let receive: Parameters<NotificationBus['subscribe']>[3] | undefined;
  const db: Databases = {
    get: () => {
      databaseCalls++;
      throw new Error('Unexpected DB call');
    },
    close: async () => {},
  };
  const bus: NotificationBus = {
    publish: async () => {},
    subscribe: async (_store, _user, _id, listener) => {
      subscription?.started();
      if (subscription) {
        await subscription.ready;
        subscription.completed();
      }
      receive = listener;
      return async () => {
        receive = undefined;
      };
    },
    close: async () => {},
  };
  app = Fastify({ logger: false });
  app.decorateRequest('principal', null);
  app.decorateRequest('sessionExpiresAt', null);
  app.decorateRequest('authSessionValid', null);
  app.addHook('preHandler', async (request) => {
    if (request.headers.cookie === 'fixture-session') {
      request.principal = user;
      request.sessionExpiresAt = Date.now() + 60000;
      request.authSessionValid = async () => stillValid;
    }
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof AppError ? error.status : 400)
      .send({ code: error instanceof AppError ? error.code : 'INVALID_REQUEST' }),
  );
  await registerFulfillment(app, config, db, {
    bus,
    credentials,
    checkins: { checkedInStore: async () => checkedInStore, checkedInUsers: async () => [user.id] },
  });
  await app.ready();
  return {
    app,
    calls: () => databaseCalls,
    revoke: () => {
      stillValid = false;
    },
    removeAssignment: () => {
      checkedInStore = null;
    },
    emit: () =>
      receive?.({
        event: 'notification.created',
        notificationId: '1',
        storeId: '1',
        isNewOrder: true,
      }),
  };
}
describe('fulfillment security boundaries', () => {
  it('does not expose an OPEN notification transport before broker subscription readiness', async () => {
    // This is an explicit connection-order unit, not native Redis/source parity.
    // No event payload is fabricated: only actual injectWS upgrade is observed.
    let releaseBroker: () => void = () => {},
      markStarted: () => void = () => {};
    const brokerReady = new Promise<void>((resolve) => {
      releaseBroker = resolve;
    });
    const subscriptionStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const lifecycle: string[] = [];
    const fixture = await setup({
      ready: brokerReady,
      started: markStarted,
      completed: () => {
        lifecycle.push('broker-ready');
      },
    });
    let opened = false;
    const connecting = fixture.app
      .injectWS('/api/v1/stores/1/notifications/stream', {
        headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
      })
      .then((socket) => {
        opened = true;
        lifecycle.push('transport-open');
        return socket;
      });
    await subscriptionStarted;
    // Drain this in-process handshake turn while the broker gate remains held.
    // This schedules no retry, payload, timeout or artificial network delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const openedBeforeBrokerReady = opened;
    releaseBroker();
    const socket = await connecting;
    try {
      expect(openedBeforeBrokerReady).toBe(false);
      expect(lifecycle).toEqual(['broker-ready', 'transport-open']);
      expect(socket.readyState).toBe(socket.OPEN);
      expect(fixture.calls()).toBe(0);
    } finally {
      socket.close();
    }
  });
  it('rejects missing/invalid webhook credentials before DB work even with a browser cookie', async () => {
    const fixture = await setup();
    for (const headers of [
      {},
      { cookie: 'fixture-session' },
      { appid: 'fixture-app', appkey: 'wrong', cookie: 'fixture-session' },
    ]) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/express-orders',
        headers,
        payload: { eventId: crypto.randomUUID(), orderId: '1', storeIds: ['1'] },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('fixture-service-secret');
    }
    for (const headers of [
      {},
      { cookie: 'fixture-session' },
      { cookie: 'fixture-session', 'x-api-key': 'wrong' },
    ]) {
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/express-shipments',
        headers,
        payload: { commandId: crypto.randomUUID(), orderId: '1', awb: 'FIXTURE' },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(fixture.calls()).toBe(0);
  });
  it('rejects an operator switch or unauthorized store before mutating anything', async () => {
    const fixture = await setup();
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/stores/1/fulfillment/orders/10/acceptance',
      headers: { cookie: 'fixture-session', 'x-operator-id': '2' },
      payload: { commandId: crypto.randomUUID() },
    });
    expect(response.statusCode).toBe(409);
    expect(fixture.calls()).toBe(0);
    const denied = await fixture.app.inject({
      url: '/api/v1/stores/2/fulfillment/summary',
      headers: { cookie: 'fixture-session' },
    });
    expect(denied.statusCode).toBe(403);
    expect(fixture.calls()).toBe(0);
  });
  it('requires the approved websocket origin and closes a revoked session before publication', async () => {
    const fixture = await setup();
    await expect(
      fixture.app.injectWS('/api/v1/stores/1/notifications/stream', {
        headers: { cookie: 'fixture-session', origin: 'https://wrong.example' },
      }),
    ).rejects.toThrow();
    const socket = await fixture.app.injectWS('/api/v1/stores/1/notifications/stream', {
      headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
    });
    const first = new Promise<string>((resolve) =>
      socket.once('message', (value) => resolve(String(value))),
    );
    fixture.emit();
    expect(JSON.parse(await first)).toEqual({
      event: 'notification.created',
      notificationId: '1',
      storeId: '1',
      isNewOrder: true,
    });
    fixture.revoke();
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    fixture.emit();
    expect(await closed).toBe(1008);
    expect(fixture.calls()).toBe(0);
  });
  it('rejects an unchecked-in socket and closes a live socket before publication after store access is removed', async () => {
    const fixture = await setup(),
      socket = await fixture.app.injectWS('/api/v1/stores/1/notifications/stream', {
        headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
      });
    fixture.removeAssignment();
    const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
    fixture.emit();
    expect(await closed).toBe(1008);
    await expect(
      fixture.app.injectWS('/api/v1/stores/1/notifications/stream', {
        headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
      }),
    ).rejects.toThrow();
    expect(fixture.calls()).toBe(0);
  });
});
