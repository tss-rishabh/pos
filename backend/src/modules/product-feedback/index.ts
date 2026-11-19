import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { noQuery, routeSchema, transportHeaders } from '../../domain/route-validation.js';
import { feedbackPage, feedbackSubmission, productFeedbackScope } from './contracts.js';
import { productFeedbackService } from './service.js';
import type { OrderRedis } from '../fulfillment/order-redis.js';

export function registerProductFeedback(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  redis: OrderRedis,
) {
  const service = productFeedbackService(config, db, redis);
  const path =
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customers/:customerId/orders/:orderId/product-feedback';
  const submissionScope = productFeedbackScope.extend({ operationId: z.uuid() }).strict();
  app.get(
    path,
    {
      config: {
        trace: { module: 'product-feedback', resource: 'product-feedback', action: 'read' },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      // The service parses the query with the same `feedbackPage`.
      ...routeSchema({
        params: productFeedbackScope,
        querystring: feedbackPage,
        headers: transportHeaders,
      }),
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
      // The service parses the body with the same `feedbackSubmission`.
      ...routeSchema({
        params: productFeedbackScope,
        querystring: noQuery,
        body: feedbackSubmission,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
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
      ...routeSchema({
        params: submissionScope,
        querystring: noQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      const { operationId, ...scope } = submissionScope.parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.receipt(authenticated(request), scope, operationId));
    },
  );
}
