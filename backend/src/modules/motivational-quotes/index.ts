import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
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
    },
    (request) => {
      authenticated(request);
      z.object({}).strict().parse(request.query);
      return { text: motivationalQuotePool[randomInt(motivationalQuotePool.length)]! };
    },
  );
}
