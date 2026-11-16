import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { registerLegacyLifecycle } from '../../src/modules/legacy-fulfillment/lifecycle/index.js';

describe('local-delivery HTTP credential and validation boundary', () => {
  it('rejects missing or invalid independent service credentials before DB work even with a browser principal and cookie', async () => {
    const app = Fastify(),
      get = vi.fn(() => {
        throw new Error('Unexpected fixture DB access.');
      }),
      db: Databases = { get, close: async () => {} },
      traces: unknown[] = [],
      user: Principal = {
        id: '44',
        name: 'Fixture',
        email: 'fixture@example.test',
        role: 4,
        userType: 1,
        storeIds: ['1'],
      };
    let current: Principal | null = user;
    app.decorateRequest('principal', null);
    app.addHook('onRequest', async (request) => {
      request.principal = current;
    });
    app.addHook('onRoute', (route) => {
      traces.push(route.config?.trace);
    });
    app.setErrorHandler((error, _request, reply) => {
      void reply
        .status(error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500)
        .send({ error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' } });
    });
    registerLegacyLifecycle(
      app,
      readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'delivery-http-test-'.repeat(4),
      }),
      db,
      {
        environment: {
          APP_ID: 'arrival-fixture',
          APP_KEY: 'arrival-fixture-key-1234',
          TSS_OBERVER_APP_ID: 'observer-fixture',
          TSS_OBERVER_APP_KEY: 'observer-fixture-key-1234',
        },
      },
    );
    try {
      for (const resource of ['arrivals', 'cancellations']) {
        const url = '/api/v1/integrations/local-deliveries/' + resource;
        for (const headers of [
          {},
          { appid: 'wrong', appkey: 'wrong' },
          { appid: 'arrival-fixture', appkey: 'wrong' },
        ]) {
          const response = await app.inject({
            method: 'POST',
            url,
            headers: { ...headers, cookie: 'pos_session=fixture-cookie' },
            payload: { order_id: '9007199254740993', location_id: '1' },
          });
          expect(response.statusCode).toBe(401);
          expect(response.json()).toEqual({ error: { code: 'SERVICE_AUTHENTICATION_REQUIRED' } });
        }
      }
      const arrival = '/api/v1/integrations/local-deliveries/arrivals',
        headers = { appid: 'arrival-fixture', appkey: 'arrival-fixture-key-1234' };
      for (const payload of [
        { order_id: 9007199254740992, location_id: '1' },
        { order_id: '1', location_id: '1', system: true },
        { order_id: '1', location_id: '1', is_notify: 'yes' },
      ])
        expect(
          (await app.inject({ method: 'POST', url: arrival, headers, payload })).statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: arrival,
            headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
            payload: 'order_id=1&order_id=2&location_id=1',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: arrival + '?appkey=not-accepted',
            headers,
            payload: { order_id: '1', location_id: '1' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: arrival,
            headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
            payload: 'order_id=9007199254740993&location_id=1&is_notify=0',
          })
        ).statusCode,
      ).toBe(503);
      const base = '/api/v1/stores/1/local-deliveries/orders/9007199254740993',
        command = crypto.randomUUID();
      for (const [method, url] of [
        ['GET', base + '/capabilities'],
        ['GET', base + '/commands'],
        ['POST', base + '/courier-requests'],
        ['POST', base + '/transfers'],
        ['POST', base + '/online-conversions'],
        ['POST', base + '/cancellations'],
        ['GET', '/api/v1/local-delivery-commands/' + command],
        ['POST', '/api/v1/local-delivery-commands/' + command + '/reconciliations'],
      ] as const) {
        current = null;
        expect(
          (
            await app.inject({
              method,
              url,
              headers: { 'x-operator-id': '44' },
              payload: method === 'POST' ? { commandId: command } : undefined,
            })
          ).statusCode,
        ).toBe(401);
        current = user;
        expect(
          (
            await app.inject({
              method,
              url,
              headers: { 'x-operator-id': '9' },
              payload: method === 'POST' ? { commandId: command } : undefined,
            })
          ).statusCode,
        ).toBe(409);
      }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: base + '/cancellations',
            headers: { 'x-operator-id': '44' },
            payload: { commandId: command, reason: 'literal', userType: 1 },
          })
        ).statusCode,
      ).toBe(400);
      expect(get).not.toHaveBeenCalled();
      expect(
        traces.filter(
          (value) =>
            z
              .object({
                module: z.literal('legacy-fulfillment'),
                resource: z.string().regex(/^[a-z][a-z-]+$/),
                action: z.string().regex(/^[a-z]+$/),
              })
              .strict()
              .safeParse(value).success,
        ).length,
      ).toBeGreaterThanOrEqual(10);
    } finally {
      await app.close();
    }
  });
});
