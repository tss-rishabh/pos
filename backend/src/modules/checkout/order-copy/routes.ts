import type { FastifyInstance, FastifyRequest } from 'fastify';
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
import type { CustomerVerificationClient } from '../customer-verification.js';
import { copyCancellationInputSchema } from './cancellation-contracts.js';

export interface OrderCopyOptions {
  customerOtp?: CustomerVerificationClient;
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
    orderCopyRepository(config, db, options.clock, { customerOtp: options.customerOtp }),
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
  async function validSession(request: FastifyRequest) {
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(
        401,
        'SESSION_EXPIRED',
        'Sign in again to access this copy reference. Its saved outcome is retained.',
      );
  }
  async function deliver<T>(request: FastifyRequest, work: () => Promise<T>) {
    await validSession(request);
    const value = await work();
    // A revoked response is withheld; an already committed cart/journal change is never undone.
    await validSession(request);
    return value;
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
    return deliver(request, () => service.prepare(user, p, input));
  });
  app.get(
    base + '/order-copy-reviews/:reviewId',
    trace('order-copy-review', 'read'),
    async (request) => {
      enabled();
      const p = scope.extend({ reviewId: z.uuid() }).parse(request.params);
      return deliver(request, () => service.review(authenticated(request), p, p.reviewId));
    },
  );
  app.get(base + '/order-copies/current', trace('order-copy', 'read-current'), async (request) => {
    enabled();
    return deliver(request, () =>
      service.current(authenticated(request), scope.parse(request.params)),
    );
  });
  app.get(base + '/order-copies/:copyId', trace('order-copy', 'read'), async (request) => {
    enabled();
    const p = scope.extend({ copyId: z.uuid() }).parse(request.params);
    return deliver(request, () => service.read(authenticated(request), p, p.copyId));
  });
  app.post(base + '/order-copies', trace('order-copy', 'create'), async (request) => {
    enabled();
    const input = mutation
      .extend({ reviewId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(request.body);
    return deliver(request, () =>
      service.start(authenticated(request), scope.parse(request.params), input),
    );
  });
  app.post(
    base + '/order-copies/:copyId/cancellations',
    trace('order-copy-cancellation', 'create'),
    async (request) => {
      enabled();
      const params = scope.extend({ copyId: z.uuid() }).parse(request.params),
        input = copyCancellationInputSchema.parse(request.body);
      return deliver(request, () =>
        service.cancelUnsent(authenticated(request), params, params.copyId, input),
      );
    },
  );
  app.get(
    base + '/order-copies/:copyId/cancellations/:cancellationId',
    trace('order-copy-cancellation', 'read'),
    async (request) => {
      enabled();
      const params = scope
        .extend({ copyId: z.uuid(), cancellationId: z.uuid() })
        .parse(request.params);
      return deliver(request, () =>
        service.cancellation(authenticated(request), params, params.copyId, params.cancellationId),
      );
    },
  );
  app.post(
    base + '/order-copies/:copyId/continuations',
    trace('order-copy', 'continue'),
    async (request) => {
      enabled();
      const p = scope.extend({ copyId: z.uuid() }).parse(request.params);
      return deliver(request, () =>
        service.continue(
          authenticated(request),
          p,
          p.copyId,
          mutation.strict().parse(request.body),
        ),
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
      return deliver(request, () =>
        service.acknowledge(authenticated(request), p, p.copyId, input),
      );
    },
  );
  return service;
}
