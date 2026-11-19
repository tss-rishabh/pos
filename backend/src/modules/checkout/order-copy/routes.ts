import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import { noQuery, routeSchema, transportHeaders } from '../../../domain/route-validation.js';
import type { JobProducer } from '../../../jobs/contract.js';
import { checkoutSessionStore, type CheckoutSessionStore } from '../session-store.js';
import { configuredStateStore, type PosStateStore } from '../state-store.js';
import { orderCopyInputSchema, type CopyCartPort, type CopyFactsPort } from './contracts.js';
import { orderCopyService } from './service.js';

export interface OrderCopyOptions {
  stateStore?: PosStateStore;
  sessions?: CheckoutSessionStore;
  jobs?: JobProducer;
  /** TRANSITIONAL, unused: legacy reads the source order from MySQL. Remove from app.ts. */
  history?: CopyFactsPort;
}

/** Legacy `ajax-fetch-the-products/` (order/urls.py:78, AjaxFetchTheProducts order/views.py:2045). */
export function registerOrderCopy(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  cart: CopyCartPort,
  options: OrderCopyOptions = {},
) {
  const stateStore = options.stateStore ?? configuredStateStore(config),
    service = orderCopyService(
      config,
      db,
      options.sessions ?? checkoutSessionStore(stateStore),
      cart,
      app.log,
    );
  const scope = z.object({ storeId: identifier, checkoutId: z.uuid() }).strict();
  app.post(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/order-copies',
    {
      config: { trace: { module: 'checkout', resource: 'order-copy', action: 'create' } },
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: orderCopyInputSchema,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      const user = authenticated(request),
        params = scope.parse(request.params),
        input = orderCopyInputSchema.parse(request.body);
      return service.copy(user, params, input);
    },
  );
  return service;
}
