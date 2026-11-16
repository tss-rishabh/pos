import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import { cancellationInputSchema } from './contracts.js';
import {
  pendingCancellationRepository,
  type PendingCancellationRepositoryOptions,
} from './repository.js';
export function registerPendingOrderCancellations(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: PendingCancellationRepositoryOptions,
) {
  const service = pendingCancellationRepository(db, config, options),
    scope = z.object({ storeId: identifier, orderId: identifier }),
    base = '/api/v1/stores/:storeId/orders/:orderId/cancellations',
    trace = (action: string) => ({
      config: { trace: { module: 'checkout', resource: 'pending-order-cancellation', action } },
    });
  app.get(base, trace('list'), (request) => {
    const p = scope.parse(request.params);
    return service.context(authenticated(request), p.storeId, p.orderId);
  });
  app.post(base, trace('create'), async (request, reply) => {
    const p = scope.parse(request.params);
    return reply
      .code(201)
      .send(
        await service.create(
          authenticated(request),
          p.storeId,
          p.orderId,
          cancellationInputSchema.parse(request.body),
        ),
      );
  });
  app.get(base + '/:cancellationId', trace('read'), (request) => {
    const p = scope.extend({ cancellationId: z.uuid() }).parse(request.params);
    return service.get(authenticated(request), p.storeId, p.orderId, p.cancellationId);
  });
  return service;
}
