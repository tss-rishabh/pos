import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerOperatorBinding } from '../src/auth/operator-binding.js';
import { AppError } from '../src/domain/errors.js';
import { demoUser } from '../src/modules/demo.js';

it('rejects stale or missing browser actor bindings before any resource action after a cookie user changes', async () => {
  const app = Fastify({ logger: false });
  let current = '101',
    writes = 0;
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request) => {
    request.principal = { ...demoUser, id: current };
  });
  registerOperatorBinding(app);
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof AppError ? error.status : 500)
      .send({ code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' }),
  );
  app.post('/api/v1/fixture', async () => {
    writes++;
    return { saved: true };
  });
  app.get('/api/v1/fixture', async () => ({ read: true }));
  app.post('/api/v1/auth/fixture', async () => ({ login: true }));
  app.post('/api/v1/service-fixture', { config: { authentication: 'service' } }, async () => ({
    service: true,
  }));
  try {
    expect((await app.inject({ method: 'POST', url: '/api/v1/fixture' })).statusCode).toBe(409);
    current = '102';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/fixture',
          headers: { 'x-operator-id': '101' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ url: '/api/v1/fixture', headers: { 'x-operator-id': '101' } }))
        .statusCode,
    ).toBe(409);
    expect(writes).toBe(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/fixture',
          headers: { 'x-operator-id': '102' },
        })
      ).statusCode,
    ).toBe(200);
    expect(writes).toBe(1);
    expect((await app.inject('/api/v1/fixture')).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/fixture' })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: 'POST', url: '/api/v1/service-fixture' })).statusCode).toBe(
      200,
    );
  } finally {
    await app.close();
  }
});
