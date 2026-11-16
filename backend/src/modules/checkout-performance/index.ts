import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { performanceIdentifier, performanceScope } from './contracts.js';
import { checkoutPerformanceService } from './service.js';

export function registerCheckoutPerformance(app: FastifyInstance, config: Config, db: Databases) {
  const service = checkoutPerformanceService(config, db),
    base = '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/performance';
  function actor(request: FastifyRequest) {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Sign in before continuing.',
      );
    return user;
  }
  app.get(
    base,
    {
      config: {
        trace: { module: 'checkout-performance', resource: 'checkout-performance', action: 'read' },
      },
    },
    async (request, reply) => {
      const query = z.object({ orderId: performanceIdentifier }).strict().parse(request.query);
      reply.header('Cache-Control', 'private, no-store');
      return service.read(actor(request), performanceScope.parse(request.params), query.orderId);
    },
  );
  app.post(
    base,
    {
      config: {
        trace: {
          module: 'checkout-performance',
          resource: 'checkout-performance',
          action: 'record',
        },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      reply.header('Cache-Control', 'private, no-store');
      return service.record(actor(request), performanceScope.parse(request.params), request.body);
    },
  );
  app.get(
    base + '/submissions/:operationId',
    {
      config: {
        trace: {
          module: 'checkout-performance',
          resource: 'checkout-performance-submission',
          action: 'read',
        },
      },
    },
    async (request, reply) => {
      const { operationId, ...scope } = performanceScope
        .extend({ operationId: z.uuid() })
        .strict()
        .parse(request.params);
      z.object({}).strict().parse(request.query);
      reply.header('Cache-Control', 'private, no-store');
      return service.receipt(actor(request), scope, operationId);
    },
  );
  return service;
}
