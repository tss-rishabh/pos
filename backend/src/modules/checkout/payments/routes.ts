import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import {
  noBody,
  noQuery,
  routeSchema,
  transportHeaders,
} from '../../../domain/route-validation.js';
import type { JobProducer } from '../../../jobs/contract.js';
import { configuredStateStore, type PosStateStore } from '../state-store.js';
import type { CheckoutSessionStore } from '../session-store.js';
import { paymentInputSchema, paymentStatusInputSchema, type PaymentGateway } from './contracts.js';
import { paymentEnvironment, terminalGateway } from './gateway.js';
import { orderPushEnvironment, orderPushes, type OrderPushes } from './order-pushes.js';
import { paymentRepository, type PaymentRepositoryOptions } from './repository.js';
import { paymentService } from './service.js';

export interface PaymentRegistrationOptions extends PaymentRepositoryOptions {
  gateway?: PaymentGateway;
  pushes?: OrderPushes;
  stateStore?: PosStateStore;
  /** Shared checkout dependency; payments no longer read checkout sessions. */
  sessions?: CheckoutSessionStore;
  /** Shared checkout dependency; payments enqueue no jobs (legacy pushes are synchronous). */
  jobs?: JobProducer;
}
const empty = z.object({}).strict();
export function registerPayments(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: PaymentRegistrationOptions = {},
) {
  const stateStore = options.stateStore ?? configuredStateStore(config);
  const service = paymentService(
    paymentRepository(db, config, options),
    options.gateway || terminalGateway(config, paymentEnvironment()),
    {
      stateStore,
      pushes:
        options.pushes ??
        orderPushes(config, orderPushEnvironment(), fetch, (event) =>
          app.log.info({
            eventId: `checkout.${event.kind}.${event.outcome}`,
            module: 'checkout',
            resource: event.kind,
          }),
        ),
    },
  );
  if (!options.stateStore) app.addHook('onClose', () => stateStore.close());
  const scope = z.object({ storeId: identifier, orderId: identifier }).strict(),
    attemptScope = scope.extend({ attemptId: z.uuid() }),
    transactionScope = scope.extend({
      transactionId: z.string().regex(/^[A-Za-z0-9-]{1,45}$/),
    }),
    order = '/api/v1/stores/:storeId/orders/:orderId',
    base = order + '/payment-attempts',
    terminal = order + '/terminal-transactions/:transactionId',
    trace = (resource: string, action: string) => ({
      config: { trace: { module: 'checkout', resource, action } },
    }),
    orderRead = routeSchema({ params: scope, querystring: noQuery, headers: transportHeaders }),
    terminalAction = routeSchema({
      params: transactionScope,
      querystring: noQuery,
      body: noBody,
      headers: transportHeaders,
    });
  app.get(
    order + '/payment-context',
    { ...trace('order-payment-context', 'read'), ...orderRead },
    async (request) => {
      empty.parse(request.query ?? {});
      const p = scope.parse(request.params);
      return service.paymentContext(authenticated(request), p.storeId, p.orderId);
    },
  );
  app.get(
    order + '/payment-options',
    { ...trace('payment-option', 'list'), ...orderRead },
    async (request) => {
      empty.parse(request.query ?? {});
      const p = scope.parse(request.params);
      return service.options(authenticated(request), p.storeId, p.orderId);
    },
  );
  app.post(
    base,
    {
      ...trace('payment-attempt', 'create'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: paymentInputSchema,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      const user = authenticated(request),
        p = scope.parse(request.params),
        body = paymentInputSchema.parse(request.body);
      const result = await service.start(user, p.storeId, p.orderId, body);
      return reply.code(result.status === 'paid' ? 201 : 202).send(result);
    },
  );
  app.get(
    base + '/:attemptId',
    {
      ...trace('payment-attempt', 'read'),
      ...routeSchema({ params: attemptScope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => {
      const p = attemptScope.parse(request.params);
      return service.get(authenticated(request), p.storeId, p.orderId, p.attemptId);
    },
  );
  app.post(
    terminal + '/status-checks',
    { ...trace('terminal-transaction', 'status'), ...terminalAction },
    async (request) => {
      const p = transactionScope.parse(request.params);
      empty.parse(request.body ?? {});
      return service.status(authenticated(request), p.storeId, p.orderId, p.transactionId);
    },
  );
  app.post(
    terminal + '/cancellations',
    { ...trace('terminal-transaction', 'cancel'), ...terminalAction },
    async (request) => {
      const p = transactionScope.parse(request.params);
      empty.parse(request.body ?? {});
      return service.cancel(authenticated(request), p.storeId, p.orderId, p.transactionId);
    },
  );
  /** Legacy `ajax-payment-status/` (order/urls.py:40, order/views.py:685-775). */
  app.post(
    order + '/payment-status',
    {
      ...trace('order-payment-status', 'update'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: paymentStatusInputSchema,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      const p = scope.parse(request.params);
      return service.paymentStatus(
        authenticated(request),
        p.storeId,
        p.orderId,
        paymentStatusInputSchema.parse(request.body),
      );
    },
  );
  return service;
}
