import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { noQuery, operatorHeaders, routeSchema } from '../../domain/route-validation.js';
import type { Principal } from '../../domain/access.js';
import type { CheckoutEnvironment } from '../checkout/gateway.js';
import { quotePayable } from '../checkout/service.js';
import { orderFinalizer, orderLineSalespersons } from '../checkout/finalizer.js';
import { paymentService } from '../checkout/payments/service.js';
import { paymentRepository } from '../checkout/payments/repository.js';
import { paymentEnvironment, terminalGateway } from '../checkout/payments/gateway.js';
import { offlineSaleParamsSchema, offlineSaleUploadSchema } from './contracts.js';
import { redisOfflineSyncCoordinator, type OfflineSyncCoordinator } from './locks.js';
import { readOfflineBillingOptions } from './options.js';
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
 * created through the ordinary checkout/payment services; the provisional
 * reference is recorded as a legacy-style comments row on the order (API-v2
 * owns the order's own reference number), and Redis holds the idempotency
 * record and the short upload lock. Limits come from the backend environment. */
export function registerOfflineSync(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: OfflineSyncRegistration,
) {
  const coordinator =
    options.coordinator !== undefined
      ? options.coordinator
      : config.REDIS_URL
        ? redisOfflineSyncCoordinator(config, config.REDIS_URL)
        : null;
  const finalize = orderFinalizer(db, config),
    lineSalespersons = orderLineSalespersons(db);
  const service = offlineSyncService({
    repository: offlineSyncRepository(db, config.BUSINESS_TIMEZONE),
    limits: readOfflineBillingOptions(),
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
    finalizeOrder: async ({ orderId, storeId, counterId, salespersonId }) => {
      const state = {
        storeId,
        counterId,
        customerId: null,
        operatorCustomerId: '0',
        lineSalespersons: {},
        salespersonId,
      };
      // Legacy order flow after pos/order: line salespersons (order/views.py:2779-2795), then
      // the invoice number, generated even without a confirmed payment-order call (2799-2809).
      // Unconfirmed: no gift-card, NPS or SMS side effects.
      await lineSalespersons(state, orderId);
      return (await finalize(state, orderId, { confirmed: false })).invoice;
    },
  });
  app.addHook('onClose', async () => {
    await coordinator?.close();
  });
  app.get(
    '/api/v1/offline-billing/settings',
    {
      ...trace('offline-billing-settings', 'read'),
      ...routeSchema({ querystring: noQuery, headers: operatorHeaders }),
    },
    async (request) => {
      authenticated(request);
      noQuery.parse(request.query);
      return service.settings();
    },
  );
  app.post(
    '/api/v1/stores/:storeId/counters/:counterId/offline-sales',
    {
      ...trace('offline-sale', 'sync'),
      bodyLimit: 64_000,
      ...routeSchema({
        params: offlineSaleParamsSchema,
        querystring: noQuery,
        body: offlineSaleUploadSchema,
        headers: operatorHeaders,
      }),
    },
    async (request, reply) => {
      const user = authenticated(request);
      const params = offlineSaleParamsSchema.parse(request.params);
      noQuery.parse(request.query);
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
