import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { AppError } from '../../../domain/errors.js';
import { operatorHeaders, routeSchema } from '../../../domain/route-validation.js';
import { detailIdentifier as positiveId } from './contracts.js';
import { onlineDetailSelection } from './contracts.js';
import { onlineOrderDetailService, type OnlineOrderDetailService } from './service.js';

export function registerOnlineOrderDetails(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  service?: OnlineOrderDetailService,
) {
  const read = service ?? onlineOrderDetailService(config, db),
    detailParams = z.object({ storeId: positiveId, orderId: positiveId }).strict();
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/details',
    {
      config: { trace: { module: 'orders', resource: 'order-detail', action: 'read' } },
      ...routeSchema({
        params: detailParams,
        querystring: onlineDetailSelection,
        headers: operatorHeaders,
      }),
    },
    async (request) => {
      const user = authenticated(request),
        params = detailParams.parse(request.params),
        selection = onlineDetailSelection.parse(request.query);
      if (request.headers['x-operator-id'] !== user.id)
        throw new AppError(
          409,
          'OPERATOR_CHANGED',
          'The active operator changed. Refresh this workspace.',
        );
      if (!request.authSessionValid || !(await request.authSessionValid()))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      const result = await read.read(user, params.storeId, params.orderId, selection);
      if (!(await request.authSessionValid()))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      return result;
    },
  );
}
