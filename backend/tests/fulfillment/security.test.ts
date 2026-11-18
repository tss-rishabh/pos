import type { Duplex } from 'node:stream';
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
  invalidUpgrade?: boolean;
}) {
  let databaseCalls = 0,
    stillValid = true;
  let checkedInStore: string | null = '1';
  let subscriptions = 0,
    unsubscriptions = 0;
  let upgradeTransport: Duplex | undefined;
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
      subscriptions++;
      receive = listener;
      subscription?.started();
      try {
        if (subscription) {
          await subscription.ready;
          subscription.completed();
        }
      } catch (error) {
        receive = undefined;
        throw error;
      }
      return async () => {
        unsubscriptions++;
        receive = undefined;
      };
    },
    close: async () => {},
  };
  app = Fastify({ logger: false });
  app.server.prependListener('upgrade', (_request, transport) => {
    upgradeTransport = transport;
  });
  app.decorateRequest('principal', null);
  app.decorateRequest('sessionExpiresAt', null);
  app.decorateRequest('authSessionValid', null);
  app.addHook('preHandler', async (request) => {
    if (subscription?.invalidUpgrade) request.headers['sec-websocket-version'] = '12';
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
    subscriptions: () => ({ opened: subscriptions, closed: unsubscriptions }),
    abortUpgrade: () => {
      upgradeTransport?.destroy();
    },
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
  it('does not acquire a notification subscription for an ordinary HTTP request', async () => {
    const fixture = await setup();
    const response = await fixture.app.inject({
      url: '/api/v1/stores/1/notifications/stream',
      headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
    });
    expect(response.statusCode).toBe(404);
    expect(fixture.subscriptions()).toEqual({ opened: 0, closed: 0 });
  });
  it('rejects a failed broker subscription before upgrading', async () => {
    let rejectBroker: (error: Error) => void = () => {},
      markStarted: () => void = () => {};
    const ready = new Promise<void>((_resolve, reject) => {
      rejectBroker = reject;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fixture = await setup({ ready, started: markStarted, completed: () => {} });
    const connecting = fixture.app.injectWS('/api/v1/stores/1/notifications/stream', {
      headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
    });
    const rejected = expect(connecting).rejects.toThrow('503');
    await started;
    rejectBroker(new Error('Synthetic broker failure'));
    await rejected;
    expect(fixture.subscriptions()).toEqual({ opened: 1, closed: 0 });
  });
  it('rechecks session and store authority after broker readiness and releases the subscription once', async () => {
    for (const reason of ['session', 'assignment'] as const) {
      let release: () => void = () => {},
        markStarted: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const fixture = await setup({ ready, started: markStarted, completed: () => {} });
      const connecting = fixture.app.injectWS('/api/v1/stores/1/notifications/stream', {
        headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
      });
      const rejected = expect(connecting).rejects.toThrow(reason === 'session' ? '401' : '403');
      await started;
      if (reason === 'session') fixture.revoke();
      else fixture.removeAssignment();
      release();
      await rejected;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.subscriptions()).toEqual({ opened: 1, closed: 1 });
      await fixture.app.close();
    }
  });
  it('releases a late subscription once when the underlying upgrade transport disconnects', async () => {
    let release: () => void = () => {},
      markStarted: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fixture = await setup({ ready, started: markStarted, completed: () => {} });
    let opened = false;
    void fixture.app
      .injectWS('/api/v1/stores/1/notifications/stream', {
        headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
      })
      .then(
        (socket) => {
          opened = true;
          socket.close();
        },
        () => {},
      );
    await started;
    fixture.abortUpgrade();
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(opened).toBe(false);
    expect(fixture.subscriptions()).toEqual({ opened: 1, closed: 1 });
  });
  it('releases a prepared subscription once if the actual protocol upgrade is rejected', async () => {
    const fixture = await setup({
      ready: Promise.resolve(),
      started: () => {},
      completed: () => {},
      invalidUpgrade: true,
    });
    await expect(
      fixture.app.injectWS('/api/v1/stores/1/notifications/stream', {
        headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
      }),
    ).rejects.toThrow('400');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.subscriptions()).toEqual({ opened: 1, closed: 1 });
  });
  it('retains an existing notice during upgrade admission and releases once after normal close', async () => {
    let release: () => void = () => {},
      markStarted: () => void = () => {},
      delivered: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const message = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const fixture = await setup({ ready, started: markStarted, completed: () => {} });
    const serverClosed = new Promise<void>((resolve) => {
      fixture.app.websocketServer.once(
        'connection',
        (server: { once(event: 'close', listener: () => void): unknown }) => {
          server.once('close', () => resolve());
        },
      );
    });
    const connecting = fixture.app.injectWS(
      '/api/v1/stores/1/notifications/stream',
      { headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN } },
      {
        onInit: (socket) => {
          socket.once('message', () => delivered());
        },
      },
    );
    await started;
    fixture.emit(); // Reuses this security fixture's existing pointer, never a ready frame.
    release();
    const socket = await connecting;
    await message;
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close();
    await closed;
    await serverClosed;
    expect(fixture.subscriptions()).toEqual({ opened: 1, closed: 1 });
  });
  it('bounds the pre-upgrade notice queue and releases a late subscription once after overflow', async () => {
    let release: () => void = () => {},
      markStarted: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fixture = await setup({ ready, started: markStarted, completed: () => {} });
    const connecting = fixture.app.injectWS('/api/v1/stores/1/notifications/stream', {
      headers: { cookie: 'fixture-session', origin: config.WEB_ORIGIN },
    });
    const rejected = expect(connecting).rejects.toThrow('503');
    await started;
    for (let index = 0; index < 101; index++) fixture.emit();
    await rejected;
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.subscriptions()).toEqual({ opened: 1, closed: 1 });
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
      socket.once('message', (value: unknown) => resolve(String(value))),
    );
    fixture.emit();
    expect(JSON.parse(await first)).toEqual({
      event: 'notification.created',
      notificationId: '1',
      storeId: '1',
      isNewOrder: true,
    });
    fixture.revoke();
    const closed = new Promise<number>((resolve) =>
      socket.once('close', (code: number) => resolve(code)),
    );
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
    const closed = new Promise<number>((resolve) =>
      socket.once('close', (code: number) => resolve(code)),
    );
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
