import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import {
  legacyPaymentRecoverySchema,
  paymentInputSchema,
  type PaymentGateway,
} from './contracts.js';
import { paymentEnvironment, terminalGateway } from './gateway.js';
import { paymentRepository, type PaymentRepositoryOptions } from './repository.js';
import { paymentService } from './service.js';

export interface PaymentRegistrationOptions extends PaymentRepositoryOptions {
  gateway?: PaymentGateway;
}
export function registerPayments(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: PaymentRegistrationOptions,
) {
  const service = paymentService(
    paymentRepository(db, config, options),
    options.gateway || terminalGateway(config, paymentEnvironment()),
  );
  const scope = z.object({ storeId: identifier, orderId: identifier }),
    attemptScope = scope.extend({ attemptId: z.uuid() }),
    base = '/api/v1/stores/:storeId/orders/:orderId/payment-attempts',
    trace = (action: string) => ({
      config: { trace: { module: 'checkout', resource: 'payment-attempt', action } },
    });
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/payment-context',
    {
      config: { trace: { module: 'checkout', resource: 'order-payment-context', action: 'read' } },
    },
    async (request) => {
      const p = scope.parse(request.params);
      const user = authenticated(request);
      return service.paymentContext(user, p.storeId, p.orderId);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/orders/:orderId/legacy-payment-recoveries',
    {
      config: {
        trace: { module: 'checkout', resource: 'legacy-payment-recovery', action: 'create' },
      },
    },
    async (request, reply) => {
      const p = scope.parse(request.params);
      return reply
        .code(202)
        .send(
          await service.adoptLegacy(
            authenticated(request),
            p.storeId,
            p.orderId,
            legacyPaymentRecoverySchema.parse(request.body),
          ),
        );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/payment-options',
    { config: { trace: { module: 'checkout', resource: 'payment-option', action: 'list' } } },
    async (request) => {
      const p = scope.parse(request.params);
      const user = authenticated(request);
      return service.options(user, p.storeId, p.orderId);
    },
  );
  app.post(base, trace('create'), async (request, reply) => {
    const user = authenticated(request),
      p = scope.parse(request.params),
      body = paymentInputSchema.parse(request.body);
    const result = await service.start(user, p.storeId, p.orderId, body);
    return reply.code(result.status === 'paid' ? 201 : 202).send(result);
  });
  app.get(base, trace('list'), async (request) => {
    const p = scope.parse(request.params);
    const user = authenticated(request);
    return {
      data: await service.list(user, p.storeId, p.orderId),
    };
  });
  app.get(base + '/:attemptId', trace('read'), async (request) => {
    const p = attemptScope.parse(request.params);
    const user = authenticated(request);
    return service.get(user, p.storeId, p.orderId, p.attemptId);
  });
  app.post(base + '/:attemptId/reconciliations', trace('reconcile'), async (request) => {
    const p = attemptScope.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body || {});
    const user = authenticated(request);
    return service.reconcile(user, p.storeId, p.orderId, p.attemptId);
  });
  app.post(base + '/:attemptId/cancellations', trace('cancel'), async (request) => {
    const p = attemptScope.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body || {});
    const user = authenticated(request);
    return service.cancel(user, p.storeId, p.orderId, p.attemptId);
  });
  return service;
}
