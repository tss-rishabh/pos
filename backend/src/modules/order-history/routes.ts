import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import type { OrdersService } from '../orders.js';
import { orderListQuery, orderReadSelection } from './contracts.js';

async function assertSessionCurrent(request: FastifyRequest) {
  if (!request.authSessionValid || !(await request.authSessionValid())) {
    throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  }
}

export function registerPublicOrders(app: FastifyInstance, orders: OrdersService) {
  const scope = z.object({ storeId: identifier });
  app.get(
    '/api/v1/stores/:storeId/orders',
    { config: { trace: { module: 'orders', resource: 'order', action: 'list' } } },
    async (request) => {
      const user = authenticated(request),
        { storeId } = scope.parse(request.params),
        query = orderListQuery.parse(request.query);
      const result = await orders.list(user, storeId, query.before, query.limit, {
        from: query.from,
        to: query.to,
        intent: query.intent,
      });
      await assertSessionCurrent(request);
      return result;
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId',
    { config: { trace: { module: 'orders', resource: 'order', action: 'read' } } },
    async (request) => {
      const user = authenticated(request),
        params = scope.extend({ orderId: identifier }).parse(request.params),
        selection = orderReadSelection.parse(request.query);
      const result = await orders.detail(user, params.storeId, params.orderId, selection);
      await assertSessionCurrent(request);
      // Preserve driver IDs exactly in both live and synthetic review responses.
      return JSON.parse(
        JSON.stringify(result, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      ) as unknown;
    },
  );
}
