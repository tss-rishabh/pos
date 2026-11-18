import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import { AppError } from '../src/domain/errors.js';
import { demoUser } from '../src/modules/demo.js';
import { registerMotivationalQuotes } from '../src/modules/motivational-quotes/index.js';
import { motivationalQuotePool } from '../src/modules/motivational-quotes/pool.js';
import { registerEventCatalog, resourceRoutes } from '../src/observability/events.js';
import { goldenStdout } from './golden/load.js';

describe('source customer-service thoughts', () => {
  it('preserves every result of the actual pinned Python handler', () => {
    const output = goldenStdout('core', 'motivational-quotes');
    expect(z.array(z.string()).parse(JSON.parse(output) as unknown)).toEqual(motivationalQuotePool);
    expect(motivationalQuotePool).toHaveLength(83);
  });

  it('requires authentication and serves only a source quote under a resource event', async () => {
    const app = Fastify();
    registerEventCatalog(app);
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-fixture-operator'] === 'signed-in') request.principal = demoUser;
    });
    app.setErrorHandler((error, _request, reply) => {
      const status =
        error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500;
      return reply.code(status).send({ rejected: true });
    });
    registerMotivationalQuotes(app);
    try {
      const anonymous = await app.inject('/api/v1/motivational-quotes/random');
      expect(anonymous.statusCode).toBe(401);
      const headers = { 'x-fixture-operator': 'signed-in' };
      const reply = await app.inject({ url: '/api/v1/motivational-quotes/random', headers });
      expect(reply.statusCode).toBe(200);
      const body = z
        .object({ text: z.string() })
        .strict()
        .parse(reply.json() as unknown);
      expect(motivationalQuotePool).toContain(body.text);
      expect(resourceRoutes(app)).toEqual([
        {
          module: 'workspace',
          resource: 'motivational-quote',
          action: 'read',
          method: 'GET',
          path: '/api/v1/motivational-quotes/random',
          authentication: 'session',
        },
      ]);
      const malformed = await app.inject({
        url: '/api/v1/motivational-quotes/random?text=untrusted',
        headers,
      });
      expect(malformed.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
