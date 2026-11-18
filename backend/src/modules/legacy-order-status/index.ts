import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { authenticated } from '../../auth/routes.js';
import { statusRequestInput } from './domain.js';
import { wholeOrderStatusService, type WholeOrderStatusService } from './service.js';
import { readWholeOrderStatusOptions, type WholeOrderStatusOptions } from './options.js';
export { wholeOrderStatusService, readWholeOrderStatusOptions };
export { registerJobHandlers, enqueuePushVincOrderForAll } from './jobs.js';

export async function registerWholeOrderStatus(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: WholeOrderStatusOptions = readWholeOrderStatusOptions(),
  dependencies: Parameters<typeof wholeOrderStatusService>[3] & {
    service?: WholeOrderStatusService;
  } = {},
) {
  const service =
      dependencies.service ?? wholeOrderStatusService(config, db, options, dependencies),
    scope = z.object({ storeId: identifier, orderId: identifier }).strict(),
    empty = z.object({}).strict();
  const trace = (resource: string, action: string) => ({
    config: { trace: { module: 'whole-order-status', resource, action } },
  });
  async function checked<T>(request: FastifyRequest, run: () => Promise<T>) {
    authenticated(request);
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'SESSION_EXPIRED', 'Sign in again to continue.');
    return run();
  }
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/fulfillment-status',
    trace('whole-order-status', 'read'),
    async (request) => {
      const { storeId, orderId } = scope.parse(request.params);
      empty.parse(request.query);
      return checked(request, () => service.status(authenticated(request), storeId, orderId));
    },
  );
  /** Legacy `ajax-update-status-vinc/` (`order/urls.py:80`). */
  app.post(
    '/api/v1/stores/:storeId/orders/:orderId/status-requests',
    trace('whole-order-status-command', 'create'),
    async (request) => {
      const { storeId, orderId } = scope.parse(request.params),
        body = statusRequestInput.parse(request.body);
      empty.parse(request.query);
      const result = await checked(request, () =>
        service.push(authenticated(request), storeId, orderId, body.platform),
      );
      if (result.outcome !== 'sent')
        request.log.warn(
          {
            module: 'whole-order-status',
            resource: 'sync-repo-status',
            eventId: 'whole-order-status.sync-repo.not-sent',
            requestId: request.id,
            userId: authenticated(request).id,
            outcome: result.outcome,
          },
          'Sync-repo status request was not delivered.',
        );
      return { message: result.message };
    },
  );
  return service;
}
