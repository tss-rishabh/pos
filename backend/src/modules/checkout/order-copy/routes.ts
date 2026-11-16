import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import { AppError } from '../../../domain/errors.js';
import { copySourceSchema, type CopyCartPort, type CopyFactsPort } from './contracts.js';
import { orderCopyFacts } from './reader.js';
import { orderCopyRepository } from './repository.js';
import { orderCopyService } from './service.js';

export interface OrderCopyOptions {
  history?: CopyFactsPort;
  facts?: CopyFactsPort;
  clock?: () => number;
}
export function registerOrderCopy(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  cart: CopyCartPort,
  options: OrderCopyOptions = {},
) {
  const service = orderCopyService(
    config,
    orderCopyRepository(config, db, options.clock),
    options.facts ?? orderCopyFacts(db, options.history, options.clock),
    cart,
    options.clock,
  );
  const base = '/api/v1/stores/:storeId/checkout-sessions/:checkoutId';
  const scope = z.object({ storeId: identifier, checkoutId: z.uuid() });
  const mutation = z.object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
  });
  const trace = (resource: string, action: string) => ({
    config: { trace: { module: 'checkout', resource, action } },
  });
  function enabled() {
    if (config.DEMO_MODE)
      throw new AppError(
        503,
        'ORDER_COPY_UNAVAILABLE',
        'Order copying is unavailable in this workspace.',
      );
  }
  app.post(base + '/order-copy-reviews', trace('order-copy-review', 'create'), async (request) => {
    enabled();
    const user = authenticated(request),
      p = scope.parse(request.params),
      input = z
        .object({
          reviewId: z.uuid(),
          expectedVersion: z.number().int().nonnegative(),
          source: copySourceSchema,
        })
        .strict()
        .parse(request.body);
    return service.prepare(user, p, input);
  });
  app.get(
    base + '/order-copy-reviews/:reviewId',
    trace('order-copy-review', 'read'),
    async (request) => {
      enabled();
      const p = scope.extend({ reviewId: z.uuid() }).parse(request.params);
      return service.review(authenticated(request), p, p.reviewId);
    },
  );
  app.get(base + '/order-copies/current', trace('order-copy', 'read-current'), async (request) => {
    enabled();
    return service.current(authenticated(request), scope.parse(request.params));
  });
  app.get(base + '/order-copies/:copyId', trace('order-copy', 'read'), async (request) => {
    enabled();
    const p = scope.extend({ copyId: z.uuid() }).parse(request.params);
    return service.read(authenticated(request), p, p.copyId);
  });
  app.post(base + '/order-copies', trace('order-copy', 'create'), async (request) => {
    enabled();
    const input = mutation
      .extend({ reviewId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(request.body);
    return service.start(authenticated(request), scope.parse(request.params), input);
  });
  app.post(
    base + '/order-copies/:copyId/continuations',
    trace('order-copy', 'continue'),
    async (request) => {
      enabled();
      const p = scope.extend({ copyId: z.uuid() }).parse(request.params);
      return service.continue(
        authenticated(request),
        p,
        p.copyId,
        mutation.strict().parse(request.body),
      );
    },
  );
  app.post(
    base + '/order-copies/:copyId/acknowledgements',
    trace('order-copy', 'acknowledge'),
    async (request) => {
      enabled();
      const p = scope.extend({ copyId: z.uuid() }).parse(request.params),
        input = mutation
          .extend({ resultHash: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(request.body);
      return service.acknowledge(authenticated(request), p, p.copyId, input);
    },
  );
  return service;
}
