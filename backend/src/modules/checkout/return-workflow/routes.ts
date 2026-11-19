import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import type { JobProducer } from '../../../jobs/contract.js';
import type { StockProcedure } from '../../administration/stock-procedure.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { checkoutGateway, type CheckoutEnvironment, type CheckoutGateway } from '../gateway.js';
import type { CheckoutRepository } from '../contracts.js';
import type { CustomerVerificationClient } from '../customer-verification.js';
import type { CheckoutSessionStore } from '../session-store.js';
import { configuredStateStore, type PosStateStore } from '../state-store.js';
import {
  exchangeInputSchema,
  returnInputSchema,
  exchangeRecoveryScope,
  exchangeRecoveryPath,
  exchangeRecoveryClaim,
  returnWindowScopeSchema,
  returnWindowInputSchema,
  returnWindowPathSchema,
  type ReturnGateway,
} from './contracts.js';
import { returnEnvironment, returnGateway, type ReturnEnvironment } from './gateway.js';
import { returnRepository } from './repository.js';
import { returnService } from './service.js';
import { exchangeService } from './exchanges.js';
import { returnWindowExtensions } from './extensions.js';
import { returnState } from './state.js';

export interface ReturnRegistrationOptions {
  signing: CheckoutEnvironment;
  customers: CheckoutRepository;
  gateway?: ReturnGateway;
  environment?: ReturnEnvironment;
  orderGateway?: CheckoutGateway;
  /** @deprecated Ignored: returns, exchanges and date extension have no customer OTP (legacy). */
  customerOtp?: CustomerVerificationClient;
  inventoryProcedureVerified?: boolean;
  stockProcedure?: StockProcedure;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string,
    transaction: AdministrationTransaction,
  ) => Promise<void>;
  /** The operator's legacy check-in store (`check_in_{uid}`); defaults to administration/checkins. */
  checkedInStore?: (userId: string) => Promise<string | null>;
  /** Shared W4 infrastructure (Redis state, checkout sessions, legacy job queue). */
  stateStore?: PosStateStore;
  sessions?: CheckoutSessionStore;
  jobs?: JobProducer;
  /**
   * @deprecated Ignored. A failed warehouse return now enqueues the legacy
   * `core.tasks.push_vinc_order_for_all` job instead of a rewrite repair obligation.
   */
  rejectedInboundRepairDispatcherEnabled?: boolean;
}
export function registerReturns(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: ReturnRegistrationOptions,
) {
  const environment = options.environment || returnEnvironment(),
    gateway = options.gateway || returnGateway(config, environment, fetch, app.log),
    state = returnState(options.stateStore || configuredStateStore(config)),
    repository = returnRepository(db, config, {
      returnPeriodDays: environment.returnPeriodDays,
      inventoryProcedureVerified: options.inventoryProcedureVerified,
      stockProcedure: options.stockProcedure,
      assertCheckIn: options.assertCheckIn,
      checkedInStore: options.checkedInStore,
      state,
    }),
    context = {
      repository,
      customers: options.customers,
      gateway,
      signing: options.signing,
      config,
      jobs: options.jobs,
      log: app.log,
    },
    service = returnService(context),
    exchanges = exchangeService(
      context,
      options.orderGateway || checkoutGateway(config, options.signing),
    ),
    scope = z.object({ storeId: identifier, orderId: identifier, lineId: identifier }),
    returnScope = z.object({ storeId: identifier, returnId: z.uuid() }),
    exchangeScope = z.object({ storeId: identifier, exchangeId: z.uuid() }),
    trace = (action: string) => ({
      config: { trace: { module: 'checkout', resource: 'return-operation', action } },
    }),
    exchangeTrace = (action: string) => ({
      config: { trace: { module: 'checkout', resource: 'exchange-operation', action } },
    });
  const extensions = returnWindowExtensions(db, config, { repository });
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
        { counterId: q.counterId },
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
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/return-lines',
    { config: { trace: { module: 'checkout', resource: 'return-line', action: 'list' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const p = scope.omit({ lineId: true }).parse(request.params),
        query = z
          .object({
            counterId: identifier,
            after: z
              .string()
              .regex(/^\d{1,20}$/)
              .optional(),
          })
          .strict()
          .parse(request.query);
      return repository.lines(
        authenticated(request),
        p.storeId,
        p.orderId,
        query.counterId,
        query.after,
      );
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
  return service;
}
