import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { registerCustomerHistory } from '../../src/modules/customer-history/index.js';
describe('customer-history private resource HTTP boundary', () => {
  it('rejects missing/stale identity, invalid scope/cursor and customer override before history/capture work', async () => {
    const app = Fastify(),
      user: Principal = {
        id: '44',
        role: 4,
        userType: 1,
        name: 'Fixture',
        email: 'fixture@example.test',
        storeIds: ['1'],
      },
      capture = vi.fn(),
      read = vi.fn(),
      lines = vi.fn(),
      traces: unknown[] = [],
      db: Databases = {
        get: () => {
          throw new Error('Unexpected fixture DB use.');
        },
        close: async () => {},
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
    registerCustomerHistory(
      app,
      readConfig({
        NODE_ENV: 'test',
        MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
        SESSION_SECRET: 'history-http-fixture-'.repeat(4),
      }),
      db,
      { capture, gateway: { read, lines } },
    );
    const base = '/api/v1/stores/1/checkout-sessions/00000000-0000-4000-a000-000000000001';
    try {
      for (const url of [
        base + '/customer-history',
        base + '/customer-orders/9007199254740993/lines',
      ]) {
        current = null;
        expect(
          (
            await app.inject({
              url,
              headers: { 'x-operator-id': '44', cookie: 'pos_session=fixture-cookie' },
            })
          ).statusCode,
        ).toBe(401);
        current = user;
        expect((await app.inject({ url, headers: { 'x-operator-id': '9' } })).statusCode).toBe(409);
        expect(
          (await app.inject({ url: url + '?customerId=99', headers: { 'x-operator-id': '44' } }))
            .statusCode,
        ).toBe(400);
        expect(
          (await app.inject({ url: url + '?limit=101', headers: { 'x-operator-id': '44' } }))
            .statusCode,
        ).toBe(400);
      }
      expect(
        (
          await app.inject({
            url: base + '/customer-history?returnBefore=20',
            headers: { 'x-operator-id': '44' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            url: base.replace('/1/', '/01/') + '/customer-history',
            headers: { 'x-operator-id': '44' },
          })
        ).statusCode,
      ).toBe(400);
      expect(capture).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(lines).not.toHaveBeenCalled();
      expect(
        traces.filter(
          (trace) =>
            z
              .object({
                module: z.literal('customer-history'),
                resource: z.enum(['customer-history', 'customer-order-lines']),
                action: z.literal('read'),
              })
              .strict()
              .safeParse(trace).success,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });
});
