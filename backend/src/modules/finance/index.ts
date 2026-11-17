import type { FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { closeEntriesSchema } from './domain.js';
import { financeService, type FinanceService } from './service.js';
import { cashLedgerService } from './ledger.js';
import { financeFeedOptions, financeFeedService, type FinanceFeedOptions } from './feed.js';
import { secretMatches } from '../fulfillment/options.js';
import { financeAlertOptions, financePendingAlerts } from './alerts.js';
import { closeHistoryService, dayCloseCsv } from './history.js';
import {
  paymentCorrectionFinanceOptions,
  type PaymentCorrectionFinanceOptions,
} from './payment-corrections.js';

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
const scope = z.object({ storeId: identifier, date });
const trace = (resource: string, action: string) => ({
  trace: { module: 'finance', resource, action },
});
interface RegistrationOptions {
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
  options: RegistrationOptions = {},
) {
  const corrections = options.paymentCorrections ?? paymentCorrectionFinanceOptions();
  const service = options.service || financeService(config, db, undefined, undefined, corrections);
  const history = closeHistoryService(config, db);
  const historyInput = (query: unknown) => {
    const today = Temporal.Now.instant().toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate();
    return z
      .object({
        storeIds: z
          .string()
          .max(20000)
          .transform((value) => (value ? z.array(identifier).max(500).parse(value.split(',')) : []))
          .optional(),
        from: date.default(today.subtract({ days: 1 }).toString()),
        to: date.default(today.toString()),
        attempts: z.enum(['all', 'latest']).default('all'),
        search: z.string().trim().max(100).default(''),
        page: z.coerce.number().int().min(1).max(1000000).default(1),
        pageSize: z.coerce.number().int().min(1).max(500).default(25),
      })
      .strict()
      .parse(query);
  };
  app.get(
    '/api/v1/reports/day-close-history',
    { config: trace('day-close-history', 'list') },
    async (request) => history.read(authenticated(request), historyInput(request.query)),
  );
  app.get(
    '/api/v1/reports/day-close-history/export',
    { config: trace('day-close-history-export', 'read') },
    async (request, reply) => {
      const input = historyInput(request.query),
        result = await history.read(authenticated(request), input, true);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="day-close-history-${input.from}-${input.to}.csv"`,
        )
        .send(dayCloseCsv(result.data));
    },
  );
  const feedOptions = options.feedOptions || financeFeedOptions(),
    feed = options.feed || financeFeedService(config, db, feedOptions);
  const alertOptions = options.alertOptions || financeAlertOptions(),
    alerts = options.alerts || financePendingAlerts(config, db);
  app.post(
    '/api/v1/webhooks/day-close-alerts',
    {
      config: { ...trace('pending-close-alert', 'create'), authentication: 'service' },
      preValidation: async (request) => {
        if (!secretMatches(alertOptions.REPORTS_API_KEY, request.headers['x-api-key']))
          throw new AppError(401, 'SERVICE_AUTHENTICATION_REQUIRED', 'Invalid or missing API key');
      },
    },
    async (request, reply) => {
      const body = z
        .object({ commandId: z.uuid(), date: date.optional() })
        .strict()
        .parse(request.body);
      const result = await alerts.queue(body.commandId, body.date, request.id);
      return reply.code(result.delivery === 'pending' ? 202 : 200).send(result);
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
    },
    async (request) => {
      const input = z
        .object({
          from: date,
          to: date,
          page: z.coerce.number().int().min(1).max(1000000),
          page_size: z.coerce.number().int().min(-1000000).max(1000000),
          store_code: z.string().trim().min(1).max(100).optional(),
        })
        .strict()
        .parse(request.query);
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
    { config: trace('cash-ledger-store', 'list') },
    async (request) => ledger.stores(authenticated(request)),
  );
  app.get(
    '/api/v1/reports/store-cash-balances',
    { config: trace('cash-ledger', 'read') },
    async (request) => {
      const user = authenticated(request),
        query = z
          .object({
            storeIds: z
              .string()
              .max(20000)
              .transform((value) =>
                value ? z.array(identifier).max(500).parse(value.split(',')) : [],
              )
              .optional(),
            from: date.optional(),
            to: date.optional(),
          })
          .strict()
          .parse(request.query);
      return ledger.read(user, query.storeIds, query.from, query.to);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/day-closes',
    { config: trace('day-close', 'read-current') },
    async (request) => {
      const user = authenticated(request),
        params = z.object({ storeId: identifier }).parse(request.params),
        query = z.object({ date: date.optional() }).strict().parse(request.query);
      return service.state(user, params.storeId, query.date);
    },
  );
  app.get(
    '/api/v1/finance/day-close-commands/:commandId',
    { config: trace('day-close-command', 'read') },
    async (request) => {
      const user = authenticated(request),
        params = z.object({ commandId: z.uuid() }).parse(request.params);
      return service.receipt(user, params.commandId);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/day-closes/:date',
    { config: trace('day-close', 'read') },
    async (request) => {
      const user = authenticated(request),
        params = scope.parse(request.params);
      return service.state(user, params.storeId, params.date);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/day-closes/:date/versions',
    { config: trace('day-close-version', 'list') },
    async (request) => {
      const user = authenticated(request),
        params = scope.parse(request.params),
        query = z
          .object({
            before: z.coerce.number().int().min(1).max(65535).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(30),
          })
          .strict()
          .parse(request.query);
      return service.versions(user, params.storeId, params.date, query.before, query.limit);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/day-closes/:date/versions',
    { config: trace('day-close-version', 'create') },
    async (request, reply) => {
      const user = authenticated(request),
        params = scope.parse(request.params);
      if (request.headers['x-operator-id'] !== user.id)
        throw new AppError(
          409,
          'OPERATOR_CHANGED',
          'The signed-in operator changed. Sign back in before submitting.',
        );
      const body = z
        .object({
          commandId: z.uuid(),
          expectedVersion: z.number().int().min(0).max(65534),
          entries: closeEntriesSchema,
        })
        .strict()
        .parse(request.body);
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
    { config: trace('day-close-prompt', 'read') },
    async (request) => {
      const user = authenticated(request),
        params = z.object({ storeId: identifier }).parse(request.params);
      return service.prompt(user, params.storeId);
    },
  );
  return { service, ledger, feed, alerts, history };
}
