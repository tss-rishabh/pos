import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { AppError } from '../../../domain/errors.js';
import { positiveId } from '../contracts.js';
import { orderSearchInput } from './contracts.js';
import { orderSearchService } from './service.js';
import type { OrderSearchOptions } from './options.js';
export { readOrderSearchOptions } from './options.js';
export { orderSearchService } from './service.js';
export { orderSearchInput } from './contracts.js';
export type OrderSearchService = ReturnType<typeof orderSearchService>;
export async function registerOrderSearch(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options?: OrderSearchOptions,
  dependencies: Parameters<typeof orderSearchService>[3] & { service?: OrderSearchService } = {},
) {
  const service = dependencies.service ?? orderSearchService(config, db, options, dependencies),
    params = z.object({ storeId: positiveId }).strict(),
    empty = z.object({}).strict();
  const trace = (resource: string) => ({
    config: { trace: { module: 'orders', resource, action: 'read' } },
  });
  async function checked<T>(request: FastifyRequest, work: () => Promise<T>) {
    authenticated(request);
    const result = await work();
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'SESSION_EXPIRED', 'Sign in again to continue.');
    return result;
  }
  app.post('/api/v1/stores/:storeId/orders/searches', trace('order-search'), async (request) => {
    const { storeId } = params.parse(request.params);
    empty.parse(request.query);
    const input = orderSearchInput.parse(request.body);
    return checked(request, () => service.search(authenticated(request), storeId, input));
  });
  app.get(
    '/api/v1/stores/:storeId/order-search-options',
    trace('order-search-options'),
    async (request) => {
      const { storeId } = params.parse(request.params);
      empty.parse(request.query);
      return checked(request, () => service.options(authenticated(request), storeId));
    },
  );
}
