import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import type { Principal } from '../../domain/access.js';
import type { CheckoutEnvironment } from '../checkout/gateway.js';
import { quotePayable } from '../checkout/service.js';
import { paymentService } from '../checkout/payments/service.js';
import { paymentRepository } from '../checkout/payments/repository.js';
import { paymentEnvironment, terminalGateway } from '../checkout/payments/gateway.js';
import { offlineSaleParamsSchema, offlineSaleUploadSchema } from './contracts.js';
import { redisOfflineSyncCoordinator, type OfflineSyncCoordinator } from './locks.js';
import { offlineSyncRepository } from './repository.js';
import { offlineSyncService, type OfflineCheckoutPort } from './service.js';

export interface OfflineSyncRegistration {
  /** The ordinary checkout service returned by registerCheckout. */
  checkout: OfflineCheckoutPort;
  identity: { get(id: string): Promise<Principal | null> };
  environment: CheckoutEnvironment;
  coordinator?: OfflineSyncCoordinator | null;
}

const trace = (resource: string, action: string) => ({
  config: { trace: { module: 'offline-sync', resource, action } },
});

/** Desktop offline billing sync (Phase D2). No server-side tables: the order is
 * created through the ordinary checkout/payment services, orders.order_ref_no
 * holds the provisional reference, and Redis holds the short upload lock. */
export function registerOfflineSync(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: OfflineSyncRegistration,
) {
  const coordinator =
    options.coordinator !== undefined
      ? options.coordinator
      : !config.DEMO_MODE && config.REDIS_URL
        ? redisOfflineSyncCoordinator(config, config.REDIS_URL)
        : null;
  const service = offlineSyncService({
    repository: offlineSyncRepository(db),
    coordinator,
    checkout: options.checkout,
    payments: paymentService(
      paymentRepository(db, config, {
        hashSecret: options.environment.hs256 || options.environment.hs512 || '',
        projection: options.environment,
      }),
      terminalGateway(config, paymentEnvironment()),
    ),
    operators: options.identity,
    operationSecret: config.SESSION_SECRET,
    quotePayable,
  });
  app.addHook('onClose', async () => {
    await coordinator?.close();
  });
  app.get(
    '/api/v1/offline-billing/settings',
    trace('offline-billing-settings', 'read'),
    async (request) => {
      authenticated(request);
      z.object({}).strict().parse(request.query);
      return service.settings();
    },
  );
  app.post(
    '/api/v1/stores/:storeId/counters/:counterId/offline-sales',
    { ...trace('offline-sale', 'sync'), bodyLimit: 64_000 },
    async (request, reply) => {
      const user = authenticated(request);
      const params = offlineSaleParamsSchema.parse(request.params);
      z.object({}).strict().parse(request.query);
      if (request.headers['x-operator-id'] !== user.id)
        throw new AppError(
          409,
          'OPERATOR_CHANGED',
          'The signed-in operator changed. Sign back in to sync.',
        );
      if (!request.authSessionValid || !(await request.authSessionValid()))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      const body = offlineSaleUploadSchema.parse(request.body);
      const result = await service.sync(user, params.storeId, params.counterId, body);
      return reply.code(result.status === 'created' ? 201 : 200).send(result);
    },
  );
  return service;
}
