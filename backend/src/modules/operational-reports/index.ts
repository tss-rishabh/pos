import { Temporal } from '@js-temporal/polyfill';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { customerFeedbackService } from './feedback.js';
import { inventoryAssociationService } from './inventory.js';
import {
  createReportExportStore,
  reportExportOptions,
  type ReportExportOptions,
  type ReportExportStore,
} from './export-storage.js';
import { reportExportService, type ExportBuilder } from './export-service.js';
import { reportExportWorker } from './export-worker.js';
import { registerReportExportRoutes } from './export-routes.js';
import { acceptanceReportService, acceptanceInputSchema } from './acceptance.js';
import {
  staffPerformanceService,
  salespersonInputSchema,
  cashierInputSchema,
} from './performance.js';
import { returnedOrdersReportService, returnedOrdersInputSchema } from './returned-orders.js';
import {
  orderTransactionsReportService,
  orderTransactionsInputSchema,
} from './order-transactions.js';
import { hyperlocalDailyReportService, hyperlocalDailyInputSchema } from './hyperlocal-daily.js';
import { flashSalesReportService, flashSalesInputSchema } from './flash-sales.js';
import {
  scheduledReportOptions,
  assertScheduledWorkerOptions,
  type ScheduledReportOptions,
} from './scheduled-options.js';
import { scheduledReportService } from './scheduled-service.js';
import { scheduledReportWorker } from './scheduled-worker.js';
import { registerScheduledReportRoutes } from './scheduled-routes.js';
interface RegistrationOptions {
  exportOptions?: ReportExportOptions;
  exportStore?: ReportExportStore;
  exportBuilder?: ExportBuilder;
  scheduledOptions?: ScheduledReportOptions;
  scheduledService?: ReturnType<typeof scheduledReportService>;
}
export async function registerOperationalReports(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: RegistrationOptions = {},
) {
  const feedback = customerFeedbackService(config, db),
    acceptance = acceptanceReportService(config, db),
    performance = staffPerformanceService(config, db),
    returnedOrders = returnedOrdersReportService(config, db),
    orderTransactions = orderTransactionsReportService(config, db),
    hyperlocalDaily = hyperlocalDailyReportService(config, db),
    flashSales = flashSalesReportService(config, db),
    inventory = inventoryAssociationService(db);
  app.post(
    '/api/v1/reports/customer-feedback/search',
    {
      config: {
        trace: { module: 'operational-reports', resource: 'customer-feedback', action: 'search' },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const user = authenticated(request),
        dateTime = z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/)
          .refine((value) => {
            try {
              return Temporal.PlainDateTime.from(value).year >= 1000;
            } catch {
              return false;
            }
          }, 'Use a valid local date and time.');
      const body = z
        .object({
          from: dateTime,
          to: dateTime,
          storeIds: z.array(identifier).max(500).optional(),
          orderIds: z.array(identifier).max(500).optional(),
          email: z.preprocess(
            (value) => (typeof value === 'string' ? value.trim() || undefined : value),
            z.email().max(254).optional(),
          ),
          page: z.number().int().min(1).max(1000000).default(1),
          pageSize: z.number().int().min(1).max(500).default(25),
        })
        .strict()
        .parse(request.body);
      return feedback.search(user, body);
    },
  );
  app.post(
    '/api/v1/reports/hyperlocal-acceptance/search',
    {
      config: {
        trace: {
          module: 'operational-reports',
          resource: 'hyperlocal-acceptance',
          action: 'search',
        },
      },
    },
    async (request) =>
      acceptance.read(authenticated(request), acceptanceInputSchema.parse(request.body)),
  );
  app.post(
    '/api/v1/reports/salesperson-performance/search',
    {
      config: {
        trace: {
          module: 'operational-reports',
          resource: 'salesperson-performance',
          action: 'search',
        },
      },
    },
    async (request) =>
      performance.salespeople(authenticated(request), salespersonInputSchema.parse(request.body)),
  );
  app.post(
    '/api/v1/reports/cashier-performance/search',
    {
      config: {
        trace: { module: 'operational-reports', resource: 'cashier-performance', action: 'search' },
      },
    },
    async (request) =>
      performance.cashiers(authenticated(request), cashierInputSchema.parse(request.body)),
  );
  app.post(
    '/api/v1/stores/:storeId/inventory/parent-associations',
    {
      config: {
        trace: {
          module: 'operational-reports',
          resource: 'inventory-parent-association',
          action: 'ensure',
        },
      },
    },
    async (request) => {
      const user = authenticated(request);
      if (request.headers['x-operator-id'] !== user.id)
        throw new AppError(
          409,
          'OPERATOR_CHANGED',
          'The signed-in operator changed. Sign back in before continuing.',
        );
      const params = z.object({ storeId: identifier }).parse(request.params),
        body = z
          .object({
            after: z.union([z.literal('0'), identifier]).default('0'),
            limit: z.number().int().min(1).max(2000).default(500),
          })
          .strict()
          .parse(request.body ?? {});
      return inventory.ensureParents(user, params.storeId, body.after, body.limit);
    },
  );
  const exportOptions = options.exportOptions || reportExportOptions(),
    exportStore = options.exportStore || createReportExportStore(config, exportOptions),
    exports = reportExportService(config, db, exportOptions, exportStore, options.exportBuilder),
    exportWorker = reportExportWorker(exports, exportOptions, (level, event, message) =>
      app.log[level](event, message),
    );
  if (exportOptions.REPORT_EXPORT_WORKER_ENABLED && !config.DEMO_MODE && !exportStore)
    throw new AppError(
      503,
      'REPORT_STORAGE_UNAVAILABLE',
      'Configure private report storage before enabling the export worker.',
    );
  await registerReportExportRoutes(app, exports);
  const scheduledOptions = options.scheduledOptions || scheduledReportOptions(),
    scheduled = options.scheduledService || scheduledReportService(config, db, scheduledOptions),
    scheduledWorker = scheduledReportWorker(scheduled, scheduledOptions, (level, event, message) =>
      app.log[level](event, message),
    );
  assertScheduledWorkerOptions(config, scheduledOptions);
  await registerScheduledReportRoutes(app, scheduled, scheduledOptions);
  app.addHook('onClose', async () => {
    await scheduledWorker.stop();
    await exportWorker.stop();
    exportStore?.close();
  });
  if (exportOptions.REPORT_EXPORT_WORKER_ENABLED && !config.DEMO_MODE) exportWorker.start();
  if (scheduledOptions.SCHEDULED_REPORT_WORKER_ENABLED && !config.DEMO_MODE)
    scheduledWorker.start();
  app.post(
    '/api/v1/reports/returned-orders/search',
    {
      config: {
        trace: { module: 'operational-reports', resource: 'returned-orders', action: 'search' },
      },
    },
    async (request) =>
      returnedOrders.read(authenticated(request), returnedOrdersInputSchema.parse(request.body)),
  );
  app.post(
    '/api/v1/reports/order-transactions/search',
    {
      config: {
        trace: { module: 'operational-reports', resource: 'order-transactions', action: 'search' },
      },
    },
    async (request) =>
      orderTransactions.read(
        authenticated(request),
        orderTransactionsInputSchema.parse(request.body),
      ),
  );
  app.post(
    '/api/v1/reports/hyperlocal-daily/search',
    {
      config: {
        trace: { module: 'operational-reports', resource: 'hyperlocal-daily', action: 'search' },
      },
    },
    async (request) =>
      hyperlocalDaily.read(authenticated(request), hyperlocalDailyInputSchema.parse(request.body)),
  );
  app.post(
    '/api/v1/reports/flash-sales/search',
    {
      config: {
        trace: { module: 'operational-reports', resource: 'flash-sales', action: 'search' },
      },
    },
    async (request) =>
      flashSales.read(authenticated(request), flashSalesInputSchema.parse(request.body)),
  );
  return {
    feedback,
    inventory,
    acceptance,
    performance,
    returnedOrders,
    orderTransactions,
    hyperlocalDaily,
    flashSales,
    exports,
    exportWorker,
    scheduled,
    scheduledWorker,
  };
}
