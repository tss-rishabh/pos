import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import { checkoutGateway, type CheckoutEnvironment, type CheckoutGateway } from '../gateway.js';
import type { CheckoutRepository } from '../contracts.js';
import { exchangeInputSchema, returnInputSchema, type ReturnGateway } from './contracts.js';
import { returnEnvironment, returnGateway, type ReturnEnvironment } from './gateway.js';
import { returnRepository, type ReturnRepositoryOptions } from './repository.js';
import { returnService } from './service.js';
import { returnVerificationService } from './verification.js';
import { exchangeService } from './exchanges.js';
import { returnWindowExtensions } from './extensions.js';
import {
  exchangeRecoveryScope,
  exchangeRecoveryPath,
  exchangeRecoveryClaim,
  returnWindowScopeSchema,
  returnWindowInputSchema,
  returnWindowPathSchema,
} from './contracts.js';
import type { orderFinalizer } from '../finalizer.js';
export interface ReturnRegistrationOptions extends Omit<
  ReturnRepositoryOptions,
  'hashSecret' | 'returnPeriodDays'
> {
  signing: CheckoutEnvironment;
  customers: CheckoutRepository;
  gateway?: ReturnGateway;
  environment?: ReturnEnvironment;
  orderGateway?: CheckoutGateway;
  finalizeExchangeOrder?: ReturnType<typeof orderFinalizer>;
}
export function registerReturns(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: ReturnRegistrationOptions,
) {
  const environment = options.environment || returnEnvironment(),
    gateway = options.gateway || returnGateway(config, environment),
    repository = returnRepository(db, config, {
      ...options,
      hashSecret: options.signing.hs256 || options.signing.hs512 || '',
      returnPeriodDays: environment.returnPeriodDays,
    }),
    service = returnService(
      repository,
      options.customers,
      gateway,
      options.signing,
      config.BUSINESS_TIMEZONE,
    ),
    exchanges = exchangeService(
      repository,
      options.customers,
      gateway,
      options.orderGateway || checkoutGateway(config, options.signing),
      options.signing,
      config,
      db,
      options.finalizeExchangeOrder,
    ),
    verification = returnVerificationService(db, config, options.customers, gateway, {
      secret: options.signing.hs256 || options.signing.hs512 || '',
      assertCheckIn: options.assertCheckIn,
      customerOtp: options.customerOtp,
    }),
    scope = z.object({ storeId: identifier, orderId: identifier, lineId: identifier }),
    returnScope = z.object({ storeId: identifier, returnId: z.uuid() }),
    exchangeScope = z.object({ storeId: identifier, exchangeId: z.uuid() }),
    trace = (action: string) => ({
      config: { trace: { module: 'checkout', resource: 'return-operation', action } },
    }),
    exchangeTrace = (action: string) => ({
      config: { trace: { module: 'checkout', resource: 'exchange-operation', action } },
    });
  const extensions = returnWindowExtensions(db, config, {
    repository,
    hashSecret: options.signing.hs256 || options.signing.hs512 || '',
  });
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/return-eligibility',
    { config: { trace: { module: 'checkout', resource: 'return-eligibility', action: 'read' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const p = exchangeRecoveryPath.parse(request.params),
        q = exchangeRecoveryScope
          .extend({ kind: z.enum(['return', 'exchange']) })
          .parse(request.query);
      return service.eligibility(
        authenticated(request),
        p.storeId,
        p.orderId,
        p.lineId,
        { counterId: q.counterId, verificationId: q.verificationId },
        q.kind,
      );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/exchange-recovery',
    {
      config: { trace: { module: 'checkout', resource: 'exchange-recovery', action: 'read' } },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const p = exchangeRecoveryPath.parse(request.params);
      return repository.exchangeRecovery(
        authenticated(request),
        p.storeId,
        p.orderId,
        p.lineId,
        exchangeRecoveryScope.parse(request.query),
      );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/exchange-recovery-claims/:claimId',
    {
      config: {
        trace: { module: 'checkout', resource: 'exchange-recovery-claim', action: 'read' },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const p = exchangeRecoveryPath.extend({ claimId: z.uuid() }).parse(request.params);
      return repository.exchangeRecoveryClaimStatus(
        authenticated(request),
        p.storeId,
        p.orderId,
        p.lineId,
        p.claimId,
        exchangeRecoveryScope.parse(request.query),
      );
    },
  );
  app.post(
    '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/exchange-recoveries',
    {
      config: { trace: { module: 'checkout', resource: 'exchange-recovery', action: 'claim' } },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const p = exchangeRecoveryPath.parse(request.params);
      return repository.claimExchangeRecovery(
        authenticated(request),
        p.storeId,
        p.orderId,
        p.lineId,
        exchangeRecoveryClaim.parse(request.body),
      );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/return-window',
    {
      config: {
        trace: { module: 'checkout', resource: 'return-window-extension', action: 'read' },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const p = returnWindowPathSchema.parse(request.params);
      return extensions.read(
        authenticated(request),
        p.storeId,
        p.orderId,
        p.lineId,
        returnWindowScopeSchema.parse(request.query),
      );
    },
  );
  app.put(
    '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/return-window',
    {
      config: {
        trace: { module: 'checkout', resource: 'return-window-extension', action: 'update' },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const p = returnWindowPathSchema.parse(request.params);
      return extensions.set(
        authenticated(request),
        p.storeId,
        p.orderId,
        p.lineId,
        returnWindowInputSchema.parse(request.body),
      );
    },
  );
  app.post(
    '/api/v1/stores/:storeId/orders/:orderId/return-verifications',
    {
      config: { trace: { module: 'checkout', resource: 'return-verification', action: 'create' } },
    },
    async (request) => {
      const p = scope.omit({ lineId: true }).parse(request.params),
        body = z
          .object({ operationId: z.uuid(), counterId: identifier })
          .strict()
          .parse(request.body);
      return verification.create(
        authenticated(request),
        p.storeId,
        p.orderId,
        body.operationId,
        body.counterId,
      );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/return-verifications/:verificationId',
    { config: { trace: { module: 'checkout', resource: 'return-verification', action: 'read' } } },
    async (request) => {
      const p = z.object({ storeId: identifier, verificationId: z.uuid() }).parse(request.params);
      return verification.read(authenticated(request), p.storeId, p.verificationId);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/return-verifications/:verificationId/line-items',
    { config: { trace: { module: 'checkout', resource: 'return-line', action: 'list' } } },
    async (request) => {
      const p = z.object({ storeId: identifier, verificationId: z.uuid() }).parse(request.params),
        query = z
          .object({
            after: z
              .string()
              .regex(/^\d{1,20}$/)
              .optional(),
          })
          .strict()
          .parse(request.query);
      return verification.lines(authenticated(request), p.storeId, p.verificationId, query.after);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/return-verifications/:verificationId/confirmations',
    {
      config: { trace: { module: 'checkout', resource: 'return-verification', action: 'confirm' } },
    },
    async (request) => {
      const p = z.object({ storeId: identifier, verificationId: z.uuid() }).parse(request.params),
        body = z
          .object({ operationId: z.uuid(), otp: z.string().regex(/^\d{6}$/) })
          .strict()
          .parse(request.body);
      return verification.verify(
        authenticated(request),
        p.storeId,
        p.verificationId,
        body.operationId,
        body.otp,
      );
    },
  );
  app.post(
    '/api/v1/stores/:storeId/return-verifications/:verificationId/reconciliations',
    {
      config: {
        trace: { module: 'checkout', resource: 'return-verification', action: 'reconcile' },
      },
    },
    async (request) => {
      const user = authenticated(request),
        p = z.object({ storeId: identifier, verificationId: z.uuid() }).parse(request.params),
        body = z.object({ operationId: z.uuid() }).strict().parse(request.body);
      return verification.reconcile(user, p.storeId, p.verificationId, body.operationId);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/returns',
    trace('create'),
    async (request, reply) => {
      const p = scope.parse(request.params),
        body = returnInputSchema.parse(request.body),
        result = await service.start(authenticated(request), p.storeId, p.orderId, p.lineId, body);
      return reply.code(result.phase === 'completed' ? 201 : 202).send(result);
    },
  );
  app.get('/api/v1/stores/:storeId/returns/:returnId', trace('read'), async (request) => {
    const p = returnScope.parse(request.params);
    return service.read(authenticated(request), p.storeId, p.returnId);
  });
  app.post(
    '/api/v1/stores/:storeId/returns/:returnId/continuations',
    trace('continue'),
    async (request) => {
      const p = returnScope.parse(request.params);
      z.object({})
        .strict()
        .parse(request.body || {});
      return service.continue(authenticated(request), p.storeId, p.returnId);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/exchanges',
    exchangeTrace('create'),
    async (request, reply) => {
      const p = scope.parse(request.params),
        body = exchangeInputSchema.parse(request.body),
        result = await exchanges.start(
          authenticated(request),
          p.storeId,
          p.orderId,
          p.lineId,
          body,
        );
      return reply.code(result.phase === 'completed' ? 201 : 202).send(result);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/exchanges/:exchangeId',
    exchangeTrace('read'),
    async (request) => {
      const p = exchangeScope.parse(request.params);
      return exchanges.read(authenticated(request), p.storeId, p.exchangeId);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/exchanges/:exchangeId/continuations',
    exchangeTrace('continue'),
    async (request) => {
      const p = exchangeScope.parse(request.params);
      z.object({})
        .strict()
        .parse(request.body || {});
      return exchanges.continue(authenticated(request), p.storeId, p.exchangeId);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/exchanges/:exchangeId/retries',
    exchangeTrace('retry'),
    async (request) => {
      const p = exchangeScope.parse(request.params),
        body = z.object({ salespersonId: identifier }).strict().parse(request.body);
      return exchanges.retry(authenticated(request), p.storeId, p.exchangeId, body.salespersonId);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/exchanges/:exchangeId/reconciliations',
    exchangeTrace('reconcile'),
    async (request) => {
      const p = exchangeScope.parse(request.params);
      z.object({})
        .strict()
        .parse(request.body || {});
      return exchanges.reconcile(authenticated(request), p.storeId, p.exchangeId);
    },
  );
  return service;
}
