import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { customerProfileScope } from '../customer-insights/contracts.js';
import { customerHistoryService } from './service.js';
export function registerCustomerHistory(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: Parameters<typeof customerHistoryService>[2] = {},
) {
  const service = customerHistoryService(config, db, options),
    base = '/api/v1/stores/:storeId/checkout-sessions/:checkoutId';
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
    base + '/customer-history',
    {
      config: {
        trace: { module: 'customer-history', resource: 'customer-history', action: 'read' },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return service.read(
        actor(request),
        customerProfileScope.parse(request.params),
        request.query,
      );
    },
  );
  app.get(
    base + '/customer-orders/:orderId/lines',
    {
      config: {
        trace: { module: 'customer-history', resource: 'customer-order-lines', action: 'read' },
      },
    },
    async (request, reply) => {
      const params = customerProfileScope.extend({ orderId: identifier }).parse(request.params);
      reply.header('Cache-Control', 'private, no-store');
      return service.lines(
        actor(request),
        { storeId: params.storeId, checkoutId: params.checkoutId },
        params.orderId,
        request.query,
      );
    },
  );
  return service;
}
