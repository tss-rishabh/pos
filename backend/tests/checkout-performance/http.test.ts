import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { registerRouteValidation } from '../../src/domain/route-validation.js';
import { registerCheckoutPerformance } from '../../src/modules/checkout-performance/index.js';
describe('private traced checkout timing HTTP inputs', () => {
  it('rejects absent/stale actors, malformed scope, comments and negative source-report poison before database work', async () => {
    const user: Principal = {
        id: '7',
        role: 4,
        userType: 1,
        storeIds: ['1'],
        name: 'Fixture',
        email: 'operator@example.test',
      },
      app = Fastify(),
      traces: unknown[] = [],
      base = '/api/v1/stores/1/checkout-sessions/' + randomUUID() + '/performance';
    let current: Principal | null = user,
      calls = 0;
    const db: Databases = {
      get: () => {
        calls++;
        throw new Error('Unexpected DB access.');
      },
      close: async () => {},
    };
    registerRouteValidation(app);
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
    registerCheckoutPerformance(
      app,
      readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'timing-http-fixture-'.repeat(4),
      }),
      db,
    );
    const performance = {
        product_main_list: '',
        user_behaviour: '',
        add_to_cart: '',
        proceed_to_payment: '',
        overall_performance_time: 'NaN',
      },
      payload = { operationId: randomUUID(), orderId: '9007199254740993', performance };
    try {
      current = null;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: base,
            headers: { 'x-operator-id': '7' },
            payload,
          })
        ).statusCode,
      ).toBe(401);
      current = user;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: base,
            headers: { 'x-operator-id': '8' },
            payload,
          })
        ).statusCode,
      ).toBe(409);
      for (const body of [
        { ...payload, customerId: '999' },
        { ...payload, performance: { ...performance, comment: 'private' } },
        { ...payload, performance: { ...performance, overall_performance_time: '-100' } },
        { ...payload, orderId: '9223372036854775808' },
      ])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: base,
              headers: { 'x-operator-id': '7' },
              payload: body,
            })
          ).statusCode,
        ).toBe(400);
      // The rewrite-only snapshot read was removed; legacy has no timing read endpoint.
      expect(
        (
          await app.inject({
            url: base + '?orderId=1&customerId=999',
            headers: { 'x-operator-id': '7' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            url: base + '/submissions/not-a-uuid',
            headers: { 'x-operator-id': '7' },
          })
        ).statusCode,
      ).toBe(400);
      expect(calls).toBe(0);
      expect(
        traces.every(
          (trace) =>
            z
              .object({
                module: z.literal('checkout-performance'),
                resource: z.enum(['checkout-performance', 'checkout-performance-submission']),
                action: z.enum(['read', 'record']),
              })
              .safeParse(trace).success,
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
