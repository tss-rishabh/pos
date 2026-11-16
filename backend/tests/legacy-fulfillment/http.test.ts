import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import { AppError } from '../../src/domain/errors.js';
import type { Principal } from '../../src/domain/access.js';
import { registerLegacyFulfillment } from '../../src/modules/legacy-fulfillment/index.js';
import type { legacyFulfillmentService } from '../../src/modules/legacy-fulfillment/service.js';

describe('legacy fulfillment HTTP scope and trace boundary', () => {
  it('rejects missing identity, stale actor, malformed payload and privilege overrides before service work', async () => {
    const app = Fastify(),
      user: Principal = {
        id: '44',
        name: 'Fixture',
        email: 'fixture@example.test',
        role: 4,
        userType: 1,
        storeIds: ['1'],
      };
    let current: Principal | null = user;
    const traces: unknown[] = [];
    const service: ReturnType<typeof legacyFulfillmentService> = {
      status: vi.fn(),
      execute: vi.fn(),
      receipt: vi.fn(),
    };
    app.decorateRequest('principal', null);
    app.addHook('onRequest', async (request) => {
      request.principal = current;
    });
    app.addHook('onRoute', (options) => {
      traces.push(options.config?.trace);
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
    registerLegacyFulfillment(
      app,
      readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'legacy-http-fixture-'.repeat(4),
      }),
      db,
      { service, lifecycle: false },
    );
    try {
      const base = '/api/v1/stores/1/legacy-fulfillment/orders/1001';
      for (const [method, url] of [
        ['GET', base],
        ['PUT', base + '/packing'],
        ['POST', base + '/rto-receipts'],
        ['GET', '/api/v1/legacy-fulfillment/commands/' + crypto.randomUUID()],
      ] as const) {
        current = null;
        expect(
          (
            await app.inject({
              method,
              url,
              headers: { 'x-operator-id': '44', cookie: 'pos_session=fixture-cookie' },
              payload: method === 'GET' ? undefined : { commandId: crypto.randomUUID(), note: '' },
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
              payload: method === 'GET' ? undefined : { commandId: crypto.randomUUID(), note: '' },
            })
          ).statusCode,
        ).toBe(409);
      }
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: base + '/packing',
            headers: { 'x-operator-id': '44' },
            payload: { commandId: crypto.randomUUID(), note: 'literal', userType: 1 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ url: base + '?role=1', headers: { 'x-operator-id': '44' } }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            url: base.replace('/1001', '/01'),
            headers: { 'x-operator-id': '44' },
          })
        ).statusCode,
      ).toBe(400);
      expect(service.status).not.toHaveBeenCalled();
      expect(service.execute).not.toHaveBeenCalled();
      expect(service.receipt).not.toHaveBeenCalled();
      expect(
        traces.filter(
          (value) =>
            z
              .object({
                module: z.literal('legacy-fulfillment'),
                resource: z.string(),
                action: z.string(),
              })
              .safeParse(value).success,
        ).length,
      ).toBeGreaterThanOrEqual(4);
    } finally {
      await app.close();
    }
  });
});
