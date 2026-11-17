import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import { paymentReversalInputSchema } from './contracts.js';
import { paymentReversalRepository, type PaymentReversalRepositoryOptions } from './repository.js';

export function registerPaymentReversals(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: PaymentReversalRepositoryOptions,
) {
  const service = paymentReversalRepository(db, config, options),
    scope = z.object({ storeId: identifier, orderId: identifier }),
    base = '/api/v1/stores/:storeId/orders/:orderId/payment-reversals',
    trace = (action: string) => ({
      config: { trace: { module: 'checkout', resource: 'payment-reversal', action } },
    });
  app.get(base, trace('list'), (request) => {
    const params = scope.parse(request.params);
    return service.context(authenticated(request), params.storeId, params.orderId);
  });
  app.get(base + '/:reversalId', trace('read'), (request) => {
    const params = scope.extend({ reversalId: z.uuid() }).parse(request.params);
    return service.get(authenticated(request), params.storeId, params.orderId, params.reversalId);
  });
  app.post(base, trace('create'), async (request, reply) => {
    const params = scope.parse(request.params);
    return reply
      .code(201)
      .send(
        await service.create(
          authenticated(request),
          params.storeId,
          params.orderId,
          paymentReversalInputSchema.parse(request.body),
        ),
      );
  });
  return service;
}
