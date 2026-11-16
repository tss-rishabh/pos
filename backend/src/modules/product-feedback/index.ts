import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { productFeedbackScope } from './contracts.js';
import { productFeedbackService } from './service.js';

export function registerProductFeedback(app: FastifyInstance, config: Config, db: Databases) {
  const service = productFeedbackService(config, db);
  const path =
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customers/:customerId/orders/:orderId/product-feedback';
  app.get(
    path,
    {
      config: {
        trace: { module: 'product-feedback', resource: 'product-feedback', action: 'read' },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await service.read(
            authenticated(request),
            productFeedbackScope.parse(request.params),
            request.query,
          ),
        ),
  );
  app.post(
    path,
    {
      config: {
        trace: { module: 'product-feedback', resource: 'product-feedback', action: 'create' },
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await service.submit(
            authenticated(request),
            productFeedbackScope.parse(request.params),
            request.body,
          ),
        );
    },
  );
  app.get(
    path + '/submissions/:operationId',
    {
      config: {
        trace: {
          module: 'product-feedback',
          resource: 'product-feedback-submission',
          action: 'read',
        },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      const { operationId, ...scope } = productFeedbackScope
        .extend({ operationId: z.uuid() })
        .strict()
        .parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.receipt(authenticated(request), scope, operationId));
    },
  );
}
