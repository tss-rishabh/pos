import type { FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import {
  noQuery,
  operatorHeaders,
  requestHeaders,
  routeSchema,
  transportHeaders,
} from '../../domain/route-validation.js';
import { closeEntriesSchema } from './domain.js';
import { financeService, type FinanceService } from './service.js';
import { cashLedgerService } from './ledger.js';
import { financeFeedOptions, financeFeedService, type FinanceFeedOptions } from './feed.js';
import { secretMatches } from '../fulfillment/options.js';
import { financeAlertOptions, financePendingAlerts } from './alerts.js';
import { closeHistoryService } from './history.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { reportApiKeyGuard } from '../operational-reports/scheduled-routes.js';
import {
  paymentCorrectionFinanceOptions,
  type PaymentCorrectionFinanceOptions,
} from './payment-corrections.js';
import type { RegisteredEvent } from '../../observability/event-registry.js';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDate.from(value).year >= 1000;
    } catch {
      return false;
    }
  }, 'Use a valid calendar date.');
const scope = z.strictObject({ storeId: identifier, date });
const storeParams = z.strictObject({ storeId: identifier });
const storeIdsQuery = z
  .string()
  .max(20000)
  .transform((value) => (value ? z.array(identifier).max(500).parse(value.split(',')) : []))
  .optional();
const historyQuery = z
  .object({
    storeIds: storeIdsQuery,
    from: date.optional(),
    to: date.optional(),
    attempts: z.enum(['all', 'latest']).default('all'),
    search: z.string().trim().max(100).default(''),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(25),
  })
  .strict();
const alertBody = z.object({ commandId: z.uuid(), date: date.optional() }).strict();
const feedQuery = z
  .object({
    from: date,
    to: date,
    page: z.coerce.number().int().min(1).max(1000000),
    page_size: z.coerce.number().int().min(-1000000).max(1000000),
    store_code: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const ledgerQuery = z
  .object({
    storeIds: storeIdsQuery,
    from: date.optional(),
    to: date.optional(),
  })
  .strict();
const dayCloseQuery = z.object({ date: date.optional() }).strict();
const commandParams = z.strictObject({ commandId: z.uuid() });
const versionsQuery = z
  .object({
    before: z.coerce.number().int().min(1).max(65535).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
const closeBody = z
  .object({
    commandId: z.uuid(),
    expectedVersion: z.number().int().min(0).max(65534),
    entries: closeEntriesSchema,
  })
  .strict();
/** Service API keys are compared by the guard; absence is answered with 401 there. */
const apiKeyHeader = z.string().max(4096).optional();
const trace = (resource: string, action: string) => ({
  trace: { module: 'finance', resource, action },
});
interface RegistrationOptions {
  /** Redis: day-close and pending-alert command receipts (no rewrite tables). */
  ephemeral: EphemeralStore;
  paymentCorrections?: PaymentCorrectionFinanceOptions;
  service?: FinanceService;
  feed?: ReturnType<typeof financeFeedService>;
  feedOptions?: FinanceFeedOptions;
  alerts?: ReturnType<typeof financePendingAlerts>;
  alertOptions?: ReturnType<typeof financeAlertOptions>;
}
export async function registerFinance(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: RegistrationOptions,
) {
  const corrections = options.paymentCorrections ?? paymentCorrectionFinanceOptions();
  const service =
    options.service ||
    financeService(config, db, undefined, undefined, corrections, options.ephemeral);
  const history = closeHistoryService(config, db);
  const historyInput = (query: unknown) => {
    const today = Temporal.Now.instant().toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate();
    const input = historyQuery.parse(query);
    return {
      ...input,
      from: input.from ?? today.subtract({ days: 1 }).toString(),
      to: input.to ?? today.toString(),
    };
  };
  app.get(
    '/api/v1/reports/day-close-history',
    {
      config: trace('day-close-history', 'list'),
      ...routeSchema({ querystring: historyQuery, headers: transportHeaders }),
    },
    async (request) => history.read(authenticated(request), historyInput(request.query)),
  );
  const feedOptions = options.feedOptions || financeFeedOptions(),
    feed = options.feed || financeFeedService(config, db, feedOptions);
  const alertOptions = options.alertOptions || financeAlertOptions(),
    alerts = options.alerts || financePendingAlerts(config, db, options.ephemeral, alertOptions);
  app.post(
    '/api/v1/webhooks/day-close-alerts',
    {
      config: { ...trace('pending-close-alert', 'create'), authentication: 'service' },
      preValidation: reportApiKeyGuard(alertOptions.REPORTS_API_KEY),
      ...routeSchema({
        querystring: noQuery,
        body: alertBody,
        headers: requestHeaders({ apikey: apiKeyHeader }),
      }),
    },
    async (request) => {
      const body = alertBody.parse(request.body);
      const result = await alerts.send(body.commandId, body.date);
      request.log.info(
        {
          module: 'finance',
          resource: 'pending-close-alert',
          eventId: 'finance.pending-close-alert.sent',
          requestId: request.id,
          userId: 'service-reports',
          pending: result.pending,
        } satisfies RegisteredEvent,
        'Pending day-close alerts posted',
      );
      return result;
    },
  );
  app.get(
    '/api/v1/finance/reconciliation/orders',
    {
      config: { ...trace('reconciliation-feed', 'read'), authentication: 'service' },
      preValidation: async (request) => {
        if (!secretMatches(feedOptions.GLASSBOX_FINANCE_FEED_API_KEY, request.headers['x-api-key']))
          throw new AppError(401, 'SERVICE_AUTHENTICATION_REQUIRED', 'Invalid or missing API key');
      },
      ...routeSchema({
        querystring: feedQuery,
        headers: requestHeaders({ 'x-api-key': apiKeyHeader }),
      }),
    },
    async (request) => {
      const input = feedQuery.parse(request.query);
      return feed.orders({
        from: input.from,
        to: input.to,
        page: input.page,
        pageSize: input.page_size,
        ...(input.store_code ? { storeCode: input.store_code } : {}),
      });
    },
  );
  const ledger = cashLedgerService(config, db, undefined, undefined, undefined, corrections);
  app.get(
    '/api/v1/reports/store-cash-balances/stores',
    {
      config: trace('cash-ledger-store', 'list'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => {
      const user = authenticated(request);
      return ledger.stores(user);
    },
  );
  app.get(
    '/api/v1/reports/store-cash-balances',
    {
      config: trace('cash-ledger', 'read'),
      ...routeSchema({ querystring: ledgerQuery, headers: transportHeaders }),
    },
    async (request) => {
      const user = authenticated(request),
        query = ledgerQuery.parse(request.query);
      return ledger.read(user, query.storeIds, query.from, query.to);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/day-closes',
    {
      config: trace('day-close', 'read-current'),
      ...routeSchema({
        params: storeParams,
        querystring: dayCloseQuery,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      const user = authenticated(request),
        params = storeParams.parse(request.params),
        query = dayCloseQuery.parse(request.query);
      return service.state(user, params.storeId, query.date);
    },
  );
  app.get(
    '/api/v1/finance/day-close-commands/:commandId',
    {
      config: trace('day-close-command', 'read'),
      ...routeSchema({ params: commandParams, querystring: noQuery, headers: operatorHeaders }),
    },
    async (request) => {
      const user = authenticated(request),
        params = commandParams.parse(request.params);
      return service.receipt(user, params.commandId);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/day-closes/:date',
    {
      config: trace('day-close', 'read'),
      ...routeSchema({ params: scope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => {
      const user = authenticated(request),
        params = scope.parse(request.params);
      return service.state(user, params.storeId, params.date);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/day-closes/:date/versions',
    {
      config: trace('day-close-version', 'list'),
      ...routeSchema({ params: scope, querystring: versionsQuery, headers: transportHeaders }),
    },
    async (request) => {
      const user = authenticated(request),
        params = scope.parse(request.params),
        query = versionsQuery.parse(request.query);
      return service.versions(user, params.storeId, params.date, query.before, query.limit);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/day-closes/:date/versions',
    {
      config: trace('day-close-version', 'create'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: closeBody,
        headers: operatorHeaders,
      }),
    },
    async (request, reply) => {
      const user = authenticated(request),
        params = scope.parse(request.params);
      if (request.headers['x-operator-id'] !== user.id)
        throw new AppError(
          409,
          'OPERATOR_CHANGED',
          'The signed-in operator changed. Sign back in before submitting.',
        );
      const body = closeBody.parse(request.body);
      const close = await service.close(
        user,
        params.storeId,
        params.date,
        body.commandId,
        body.expectedVersion,
        body.entries,
      );
      return reply.code(201).send({ message: 'Day closed.', data: close });
    },
  );
  app.get(
    '/api/v1/stores/:storeId/day-close-prompt',
    {
      config: trace('day-close-prompt', 'read'),
      ...routeSchema({ params: storeParams, querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => {
      noQuery.parse(request.query);
      const user = authenticated(request),
        params = storeParams.parse(request.params);
      const prompt = await service.prompt(user, params.storeId);
      return {
        ...prompt,
        nagIntervalMs: config.DAY_CLOSE_NAG_INTERVAL_MINUTES * 60000,
        businessTimeZone: config.BUSINESS_TIMEZONE,
      };
    },
  );
  return { service, ledger, feed, alerts, history };
}
