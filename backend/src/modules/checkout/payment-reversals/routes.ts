import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { paymentReversalInputSchema } from './contracts.js';
import { paymentReversalRepository, type PaymentReversalRepositoryOptions } from './repository.js';

export function registerPaymentReversals(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: PaymentReversalRepositoryOptions,
) {
  const service = paymentReversalRepository(db, config, options),
    scope = z.object({ storeId: identifier, orderId: identifier }).strict(),
    empty = z.object({}).strict(),
    base = '/api/v1/stores/:storeId/orders/:orderId/payment-reversals',
    trace = (action: string) => ({
      config: {
        trace: { module: 'checkout', resource: 'payment-reversal', action },
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    });
  async function perform<T>(request: FastifyRequest, task: (user: Principal) => Promise<T>) {
    const user = authenticated(request);
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    const result = await task(user);
    if (!(await request.authSessionValid()))
      throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return result;
  }
  app.get(base, trace('list'), async (request, reply) => {
    empty.parse(request.query);
    const params = scope.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(
        await perform(request, (user) => service.context(user, params.storeId, params.orderId)),
      );
  });
  app.get(base + '/:reversalId', trace('read'), async (request, reply) => {
    empty.parse(request.query);
    const params = scope.extend({ reversalId: z.uuid() }).parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(
        await perform(request, (user) =>
          service.get(user, params.storeId, params.orderId, params.reversalId),
        ),
      );
  });
  app.post(base, trace('create'), async (request, reply) => {
    empty.parse(request.query);
    const params = scope.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .code(201)
      .send(
        await perform(request, (user) =>
          service.create(
            user,
            params.storeId,
            params.orderId,
            paymentReversalInputSchema.parse(request.body),
          ),
        ),
      );
  });
  return service;
}
