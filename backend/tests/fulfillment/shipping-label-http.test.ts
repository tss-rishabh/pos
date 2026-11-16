import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { registerShippingLabels } from '../../src/modules/fulfillment/shipping-label/index.js';
import type { ShippingLabel } from '../../src/modules/fulfillment/shipping-label/contracts.js';

const user: Principal = {
  id: '1',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
const fixture: ShippingLabel = {
  orderId: '9007199254740993',
  storeId: '1',
  orderReference: 'FIXTURE',
  orderDate: '2026-11-16 10:00:00',
  storeAddress: 'Fixture return',
  shippingAddress: null,
  paymentMode: 'Prepaid',
  product: 'Cloths',
  totalQuantity: '9007199254740993',
  awb: '0',
  dimensionsCm: ['30.000', '30.000', '2.000'],
  weightKg: '0.384',
};
describe('private shipping-label HTTP boundary', () => {
  it('requires authenticated captured identity before every document/read, rejects malformed scope/query and adds explicit traces', async () => {
    const app = Fastify(),
      read = vi.fn(async () => fixture),
      traces: unknown[] = [];
    let principal: Principal | null = user;
    app.decorateRequest('principal', null);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    app.addHook('onRoute', (options) => {
      traces.push(options.config?.trace);
    });
    app.setErrorHandler((error, _request, reply) => {
      const status =
        error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500;
      void reply
        .status(status)
        .send({ error: { code: error instanceof AppError ? error.code : 'INVALID_INPUT' } });
    });
    const databases: Databases = {
      get: () => {
        throw new Error('Unexpected fixture database access.');
      },
      close: async () => {},
    };
    registerShippingLabels(app, databases, { read });
    try {
      const base = '/api/v1/stores/1/fulfillment/orders/9007199254740993/shipping-label';
      for (const path of [base, base + '/preview']) {
        principal = null;
        expect(
          (
            await app.inject({
              url: path,
              headers: { 'x-operator-id': '1', cookie: 'pos_session=not-a-session' },
            })
          ).statusCode,
        ).toBe(401);
        principal = user;
        for (const headers of [{}, { 'x-operator-id': '9' }])
          expect((await app.inject({ url: path, headers })).statusCode).toBe(409);
      }
      expect(read).not.toHaveBeenCalled();
      expect(
        (await app.inject({ url: base + '?userType=1', headers: { 'x-operator-id': '1' } }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            url: base.replace('/stores/1/', '/stores/01/'),
            headers: { 'x-operator-id': '1' },
          })
        ).statusCode,
      ).toBe(400);
      expect(read).not.toHaveBeenCalled();
      const response = await app.inject({ url: base, headers: { 'x-operator-id': '1' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: fixture });
      expect(response.headers['cache-control']).toBe('private, no-store');
      const preview = await app.inject({
        url: base + '/preview',
        headers: { 'x-operator-id': '1' },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers['content-type']).toContain('text/html');
      expect(preview.headers['content-security-policy']).toContain("script-src 'none'");
      expect(preview.headers['content-security-policy']).not.toContain('unsafe-inline');
      expect(preview.headers['cache-control']).toContain('no-store');
      expect(preview.headers.vary).toContain('X-Operator-ID');
      expect(preview.headers['referrer-policy']).toBe('no-referrer');
      expect(preview.body).toContain('9007199254740993');
      expect(read).toHaveBeenCalledTimes(2);
      expect(
        traces.filter(
          (value) =>
            z
              .object({
                module: z.literal('fulfillment'),
                resource: z.literal('shipping-label'),
                action: z.enum(['read', 'preview']),
              })
              .safeParse(value).success,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });
});
