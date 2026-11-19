import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { noQuery, requestHeaders, routeSchema } from '../../domain/route-validation.js';
import type { JobProducer } from '../../jobs/contract.js';
import { checkoutSessionStore, type CheckoutSessionStore } from '../checkout/session-store.js';
import { configuredStateStore, type PosStateStore } from '../checkout/state-store.js';
import { performanceInput, performanceScope } from './contracts.js';
import { checkoutPerformanceService } from './service.js';

export interface CheckoutPerformanceOptions {
  stateStore?: PosStateStore;
  sessions?: CheckoutSessionStore;
  jobs?: JobProducer;
}
const operatorHeader = requestHeaders({ 'x-operator-id': z.string().max(20).optional() });
const submissionScope = performanceScope.extend({ operationId: z.uuid() }).strict();

export function registerCheckoutPerformance(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: CheckoutPerformanceOptions = {},
) {
  const stateStore = options.stateStore ?? configuredStateStore(config),
    service = checkoutPerformanceService(db, {
      stateStore,
      sessions: options.sessions ?? checkoutSessionStore(stateStore),
    }),
    base = '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/performance',
    trace = (resource: string, action: string) => ({
      config: { trace: { module: 'checkout-performance', resource, action } },
    });
  function actor(request: FastifyRequest) {
    const user = authenticated(request);
    if (operatorHeader.parse(request.headers)['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Sign in before continuing.',
      );
    return user;
  }
  app.post(
    base,
    {
      ...trace('checkout-performance', 'record'),
      ...routeSchema({
        params: performanceScope,
        querystring: noQuery,
        body: performanceInput,
        headers: operatorHeader,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      const user = actor(request);
      reply.header('Cache-Control', 'private, no-store');
      return service.record(user, performanceScope.parse(request.params), request.body);
    },
  );
  app.get(
    base + '/submissions/:operationId',
    {
      ...trace('checkout-performance-submission', 'read'),
      ...routeSchema({
        params: submissionScope,
        querystring: noQuery,
        headers: operatorHeader,
      }),
    },
    async (request, reply) => {
      const { operationId, ...scope } = submissionScope.parse(request.params);
      noQuery.parse(request.query);
      const user = actor(request);
      reply.header('Cache-Control', 'private, no-store');
      return service.receipt(user, scope, operationId);
    },
  );
  return service;
}
