import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { authenticated } from '../../auth/routes.js';
import { noQuery, routeSchema, transportHeaders } from '../../domain/route-validation.js';
import { motivationalQuotePool } from './pool.js';

/** Quotes are immutable application content; no database read is needed. */
export function registerMotivationalQuotes(app: FastifyInstance) {
  app.get(
    '/api/v1/motivational-quotes/random',
    {
      config: {
        trace: { module: 'workspace', resource: 'motivational-quote', action: 'read' },
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    (request) => {
      authenticated(request);
      noQuery.parse(request.query);
      return { text: motivationalQuotePool[randomInt(motivationalQuotePool.length)]! };
    },
  );
}
