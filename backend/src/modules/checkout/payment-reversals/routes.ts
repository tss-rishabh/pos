import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { cashReturnClaimInput } from './intent-claim-contracts.js';
import { paymentReversalInputSchema } from './contracts.js';
import {
  cashReturnAttestInput,
  cashReturnCancelInput,
  cashReturnPrepareInput,
} from './intent-contracts.js';
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
  const currentSession = (request: FastifyRequest) => {
    const parsed = z.uuid().safeParse(request.authSessionId);
    if (!parsed.success) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return parsed.data;
  };
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
            currentSession(request),
          ),
        ),
      );
  });
  const intentBase = '/api/v1/stores/:storeId/orders/:orderId/cash-return-intents',
    intentScope = scope.extend({ intentId: z.uuid() }).strict(),
    intentTrace = (resource: string, action: string) => ({
      config: {
        trace: { module: 'checkout', resource, action },
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    });
  app.post(intentBase, intentTrace('cash-return-intent', 'prepare'), async (request, reply) => {
    empty.parse(request.query);
    const p = scope.parse(request.params),
      input = cashReturnPrepareInput.parse(request.body);
    return reply
      .header('Cache-Control', 'private, no-store')
      .code(201)
      .send(
        await perform(request, (user) =>
          service.intents.prepare(user, p.storeId, p.orderId, input, currentSession(request)),
        ),
      );
  });
  app.get(
    intentBase + '/:intentId',
    intentTrace('cash-return-intent', 'read'),
    async (request, reply) => {
      empty.parse(request.query);
      const p = intentScope.parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.intents.get(user, p.storeId, p.orderId, p.intentId, currentSession(request)),
          ),
        );
    },
  );
  app.get(
    intentBase + '/:intentId/operations/:operationId',
    intentTrace('cash-return-command', 'read'),
    async (request, reply) => {
      empty.parse(request.query);
      const p = intentScope.extend({ operationId: z.uuid() }).strict().parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.intents.command(
              user,
              p.storeId,
              p.orderId,
              p.intentId,
              p.operationId,
              currentSession(request),
            ),
          ),
        );
    },
  );
  app.post(
    intentBase + '/:intentId/armings',
    intentTrace('cash-return-intent', 'arm'),
    async (request, reply) => {
      empty.parse(request.query);
      const p = intentScope.parse(request.params),
        input = z.object({ operationId: z.uuid() }).strict().parse(request.body);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.intents.arm(
              user,
              p.storeId,
              p.orderId,
              p.intentId,
              input,
              currentSession(request),
            ),
          ),
        );
    },
  );
  app.post(
    intentBase + '/:intentId/attestations',
    intentTrace('cash-return-intent', 'attest'),
    async (request, reply) => {
      empty.parse(request.query);
      const p = intentScope.parse(request.params),
        input = cashReturnAttestInput.parse(request.body);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.intents.attest(
              user,
              p.storeId,
              p.orderId,
              p.intentId,
              input,
              currentSession(request),
            ),
          ),
        );
    },
  );
  app.post(
    intentBase + '/:intentId/cancellations',
    intentTrace('cash-return-intent', 'cancel'),
    async (request, reply) => {
      empty.parse(request.query);
      const p = intentScope.parse(request.params),
        input = cashReturnCancelInput.parse(request.body);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.intents.cancel(
              user,
              p.storeId,
              p.orderId,
              p.intentId,
              input,
              currentSession(request),
            ),
          ),
        );
    },
  );
  app.post(
    intentBase + '/:intentId/reconciliations',
    intentTrace('cash-return-intent', 'resolve'),
    async (request, reply) => {
      empty.parse(request.query);
      const p = intentScope.parse(request.params),
        input = z.object({ operationId: z.uuid() }).strict().parse(request.body);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.resolve(
              user,
              p.storeId,
              p.orderId,
              p.intentId,
              currentSession(request),
              input.operationId,
            ),
          ),
        );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/cash-return-intents',
    intentTrace('cash-return-queue', 'list'),
    async (request, reply) => {
      const p = z.object({ storeId: identifier }).strict().parse(request.params),
        q = z
          .object({
            after: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .strict()
          .parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.intents.list(user, p.storeId, currentSession(request), q.after, q.limit),
          ),
        );
    },
  );
  const claimBase = '/api/v1/stores/:storeId/orders/:orderId/cash-return-claims',
    claimScope = scope.extend({ claimId: z.uuid() }).strict();
  app.post(claimBase, intentTrace('cash-return-claim', 'retain'), async (request, reply) => {
    empty.parse(request.query);
    const p = scope.parse(request.params),
      input = cashReturnClaimInput.parse(request.body);
    return reply
      .header('Cache-Control', 'private, no-store')
      .code(201)
      .send(
        await perform(request, (user) =>
          service.claims.register(user, p.storeId, p.orderId, input, currentSession(request)),
        ),
      );
  });
  app.get(
    claimBase + '/:claimId',
    intentTrace('cash-return-claim', 'read'),
    async (request, reply) => {
      empty.parse(request.query);
      const p = claimScope.parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.claims.get(user, p.storeId, p.orderId, p.claimId, currentSession(request)),
          ),
        );
    },
  );
  app.post(
    claimBase + '/:claimId/reconciliations',
    intentTrace('cash-return-claim', 'resolve'),
    async (request, reply) => {
      empty.parse(request.query);
      const p = claimScope.parse(request.params),
        input = z.object({ operationId: z.uuid() }).strict().parse(request.body);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.resolveClaim(
              user,
              p.storeId,
              p.orderId,
              p.claimId,
              currentSession(request),
              input.operationId,
            ),
          ),
        );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/cash-return-claims',
    intentTrace('cash-return-claim-queue', 'list'),
    async (request, reply) => {
      const p = z.object({ storeId: identifier }).strict().parse(request.params),
        q = z
          .object({
            after: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .strict()
          .parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await perform(request, (user) =>
            service.claims.list(user, p.storeId, currentSession(request), q.after, q.limit),
          ),
        );
    },
  );
  return service;
}
