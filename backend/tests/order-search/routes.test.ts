import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { config } from './fixtures.js';
import type { Databases } from '../../src/db/pools.js';
import { AppError } from '../../src/domain/errors.js';
const stub = vi.hoisted(() => ({
  search: vi.fn(async () => ({ synthetic: true })),
  options: vi.fn(async () => ({ synthetic: true })),
}));
vi.mock('../../src/modules/order-history/search/service.js', () => ({
  orderSearchService: () => stub,
}));
import { registerOrderSearch } from '../../src/modules/order-history/search/index.js';
describe('private read-search transport and session boundary', () => {
  async function app(valid = true) {
    const instance = Fastify();
    instance.decorateRequest('principal', null);
    instance.decorateRequest('authSessionValid', null);
    instance.addHook('preHandler', async (request) => {
      request.principal = {
        id: '1',
        name: 'Synthetic',
        email: '',
        role: 2,
        userType: 1,
        storeIds: ['1'],
      };
      request.authSessionValid = async () => valid;
    });
    instance.setErrorHandler((error, _request, reply) => {
      reply
        .code(error instanceof AppError ? error.status : 400)
        .send({ code: error instanceof AppError ? error.code : 'VALIDATION_ERROR' });
    });
    await registerOrderSearch(instance, config, {} as Databases);
    return instance;
  }
  it('keeps contact search in the body and rejects unexpected query/body fields', async () => {
    const server = await app();
    try {
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/api/v1/stores/1/orders/searches',
            payload: { storeIds: ['1'], mobile: '555', email: 'synthetic@example.invalid' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/api/v1/stores/1/orders/searches?email=synthetic',
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await server.inject({
            method: 'POST',
            url: '/api/v1/stores/1/orders/searches',
            payload: { sort: { field: '(SELECT sensitive)', direction: 'asc' } },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await server.close();
    }
  });
  it('rejects an expired/revoked session after awaited reader work', async () => {
    const server = await app(false);
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/stores/1/orders/searches',
        payload: { storeIds: ['1'] },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: 'SESSION_EXPIRED' });
    } finally {
      await server.close();
    }
  });
});
