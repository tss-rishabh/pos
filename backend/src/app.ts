import Fastify, { LogController, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import { createDatabases } from './db/pools.js';
import { assertMigrationsCurrent } from './db/migrations.js';
import { configuredStockProjection } from './db/stock-projection/options.js';
import { identityService } from './auth/identity.js';
import { registerAuth, authenticated } from './auth/routes.js';
import { AppError } from './domain/errors.js';
import { catalogBarcode, readCatalogBarcode } from './modules/catalog-barcode.js';
import { memorySessions, mysqlSessions } from './auth/sessions.js';
import { loginChallengeService } from './auth/mfa.js';
import { otpDelivery } from './auth/delivery.js';
import { profileService } from './auth/profile.js';
import { registerProfile } from './auth/profile-routes.js';
import { profileMediaService } from './auth/profile-media.js';
import { deviceHandoffOptions, deviceHandoffService } from './auth/device-handoff.js';
import { redisDeviceHandoffStore } from './auth/device-handoff-store.js';
import { registerDeviceHandoffs } from './auth/device-handoff-routes.js';
import { registerOperatorBinding } from './auth/operator-binding.js';
import { registerProfileMedia } from './auth/profile-media-routes.js';
import { checkInService } from './modules/administration/checkins.js';
import {
  createProductSyncAdapter,
  productSynchronizer,
} from './modules/administration/product-sync.js';
import { readAdministrationWorkerOptions } from './modules/administration/worker-options.js';
import { createSettingsDelivery } from './modules/administration/settings-adapters.js';
import { readSettingsOptions } from './modules/administration/settings-options.js';
import { createCsvUploadStorage } from './modules/administration/import-storage.js';
import {
  createDocumentationMediaStore,
  createScopedMediaStore,
  readDocumentationMediaOptions,
} from './modules/administration/media-storage.js';
import { readPrivateS3Options } from './modules/administration/private-s3-client.js';
import { createStoreImageStore } from './modules/administration/store-images.js';
import { registerAdministration } from './modules/administration/index.js';
import { registerBarcodeAssignments } from './modules/administration/barcodes/index.js';
import { registerSecondaryCountrySearch } from './modules/administration/country-search.js';
import { registerOperatorModelAccounts } from './modules/administration/model-accounts/index.js';
import { registerApplicationLinks } from './modules/application-links/index.js';
import { registerMotivationalQuotes } from './modules/motivational-quotes/index.js';
import { registerDashboard } from './modules/dashboard/index.js';
import { registerGiftCardBatches } from './modules/gift-card-batches/index.js';
import { readGiftCardBatchOptions } from './modules/gift-card-batches/options.js';
import {
  readAdministrationHistoryOptions,
  registerAdministrationHistory,
} from './modules/administration-history/index.js';
import {
  createSlackOAuthProvider,
  readSlackOAuthOptions,
} from './modules/administration/slack-provider.js';
import { registerCheckout } from './modules/checkout/index.js';
import { registerOfflineSync } from './modules/offline-sync/index.js';
import {
  readWholeOrderStatusOptions,
  registerWholeOrderStatus,
} from './modules/legacy-order-status/index.js';
import { checkoutEnvironment } from './modules/checkout/gateway.js';
import {
  paymentCorrectionEvidence,
  paymentReversalOptions,
  registerPaymentReversals,
} from './modules/checkout/payment-reversals/index.js';
import { registerFulfillment } from './modules/fulfillment/index.js';
import { registerShippingLabels } from './modules/fulfillment/shipping-label/index.js';
import { registerLegacyFulfillment } from './modules/legacy-fulfillment/index.js';
import { registerCustomerWorkspace } from './modules/customer-insights/index.js';
import { registerCustomerHistory } from './modules/customer-history/index.js';
import { registerProductFeedback } from './modules/product-feedback/index.js';
import { registerCheckoutPerformance } from './modules/checkout-performance/index.js';
import { registerInvoiceDocuments } from './modules/invoice-documents/index.js';
import {
  readGlobalVoucherOptions,
  registerGlobalVouchers,
} from './modules/global-vouchers/index.js';
import { registerCustomerContacts } from './modules/customer-contacts/index.js';
import { registerCustomerWebsiteHandoff } from './modules/customer-website-handoff/index.js';
import { readCustomerContactOptions } from './modules/customer-contacts/options.js';
import {
  customerOtpService,
  readCustomerOtpOptions,
  createCustomerOtpDelivery,
} from './modules/customer-otp/index.js';
import { registerFinance } from './modules/finance/index.js';
import { paymentCorrectionFinanceOptions } from './modules/finance/payment-corrections.js';
import { registerOperationalReports } from './modules/operational-reports/index.js';
import { registerCatalogDetails } from './modules/catalog-details/index.js';
import {
  readSpecialPermissionHistoryOptions,
  registerSpecialPermissionHistory,
} from './modules/special-permission-history/index.js';
import { catalogService } from './modules/catalog.js';
import { ordersService } from './modules/orders.js';
import { publicOrderHistory } from './modules/order-history/index.js';
import { registerPublicOrders } from './modules/order-history/routes.js';
import { registerOnlineOrderDetails } from './modules/order-history/online-detail/routes.js';
import { historicalOrderCopyFacts } from './modules/order-history/copy-adapter.js';
import {
  registerOrderSearch,
  readOrderSearchOptions,
} from './modules/order-history/search/index.js';
import { demoOrderSearch } from './modules/order-history/search/demo.js';
import { draftMutationSchema, draftService } from './modules/drafts.js';
import { demoServices, demoUser } from './modules/demo.js';
import { registerEventCatalog, requestEvent } from './observability/events.js';
import { createModuleRuntime } from './jobs/module-runtime.js';
import { registerRequestTrace } from './observability/context.js';
import { identifier, cursor } from './domain/validation.js';
import { reportService, dailyReportRange } from './modules/reports.js';
import { routeRead } from './domain/routing.js';
import { mergeDailyRows, dailyTotals } from './modules/daily-report.js';
import { scopedStores } from './domain/access.js';
import { sql } from 'drizzle-orm';

const id = identifier;
const scope = z.object({ storeId: id });
class PrivateLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
export async function buildApp(
  config: Config,
  options: { logger?: FastifyServerOptions['logger'] } = {},
) {
  const logger = options.logger
    ? ({
        ...(typeof options.logger === 'object' ? options.logger : {}),
        base: null,
        mixin: () => ({
          module: 'runtime',
          resource: 'server',
          eventId: 'runtime.server.lifecycle',
          eventInstanceId: crypto.randomUUID(),
          requestId: null,
          userId: null,
        }),
        serializers: {
          req: () => ({}),
          res: (reply) => ({ statusCode: reply.statusCode }),
          err: () => ({ type: 'InternalError', message: 'Request failed', stack: '' }),
        },
      } satisfies Exclude<FastifyServerOptions['logger'], boolean | undefined>)
    : false;
  const app = Fastify({
    logger,
    bodyLimit: 256_000,
    requestTimeout: 15000,
    connectionTimeout: 10000,
    genReqId: () => crypto.randomUUID(),
    logController: new PrivateLogController(),
    trustProxy: config.TRUSTED_PROXY_CIDRS.length ? config.TRUSTED_PROXY_CIDRS : false,
  });
  registerEventCatalog(app);
  registerRequestTrace(app);
  await app.register(cookie);
  await app.register(cors, { origin: new URL(config.WEB_ORIGIN).origin, credentials: true });
  await app.register(helmet);
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  const db = createDatabases(config),
    identity = identityService(config, db);
  const paymentCorrections = paymentCorrectionFinanceOptions(),
    checkoutRuntime = checkoutEnvironment(),
    reports = reportService(config, db, { paymentCorrections }),
    orderHistory = publicOrderHistory(config);
  const services = config.DEMO_MODE
    ? demoServices()
    : {
        catalog: catalogService(db),
        orders: ordersService(db, config, orderHistory),
        drafts: draftService(db),
      };
  /** Job producer + ephemeral Redis state for the W8 modules (src/jobs). */
  const moduleRuntime = createModuleRuntime(config);
  app.addHook('onClose', async () => {
    await identity.close();
    await db.close();
    await moduleRuntime.close();
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Request-Id', request.id);
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      request.routeOptions.config.authentication !== 'service'
    ) {
      const origin = request.headers.origin;
      if (origin !== new URL(config.WEB_ORIGIN).origin)
        throw new AppError(403, 'ORIGIN_DENIED', 'Request origin is not allowed.');
    }
    if (config.DEMO_MODE) {
      const route = request.routeOptions.url || '';
      const publicRoute = [
        '/health/live',
        '/health/ready',
        '/api/v1/auth/capabilities',
        '/api/v1/operators/current/device-handoffs/capabilities',
        '/api/v1/auth/demo-sessions',
        '/api/v1/auth/sessions/current',
      ].includes(route);
      const syntheticResource = [
        '/api/v1/stores',
        '/api/v1/stores/:storeId/counters',
        '/api/v1/stores/:storeId/catalog/products',
        '/api/v1/stores/:storeId/catalog/products/by-barcode/:barcode',
        '/api/v1/stores/:storeId/orders',
        '/api/v1/stores/:storeId/orders/:orderId',
        '/api/v1/stores/:storeId/orders/searches',
        '/api/v1/stores/:storeId/order-search-options',
        '/api/v1/reports/daily-store-sales',
        '/api/v1/reports/store-cash-balances/stores',
        '/api/v1/stores/:storeId/cart-drafts',
        '/api/v1/stores/:storeId/cart-drafts/:draftId',
        '/api/v1/motivational-quotes/random',
      ].includes(route);
      const safeRead = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (
        !publicRoute &&
        !(
          syntheticResource &&
          (safeRead ||
            request.routeOptions.config.trace?.resource === 'cart-draft' ||
            (route === '/api/v1/stores/:storeId/orders/searches' && request.method === 'POST'))
        )
      )
        throw new AppError(
          403,
          'DEMO_READ_ONLY',
          'This action is unavailable in the demo workspace.',
        );
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    app.log.info(requestEvent(request, reply), 'Resource request completed');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Check the request fields.',
          requestId: request.id,
          fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    if (error instanceof AppError)
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message, requestId: request.id } });
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    if (status >= 400 && status < 500)
      return reply.code(status).send({
        error: {
          code: 'REQUEST_REJECTED',
          message: status === 429 ? 'Too many requests. Try again shortly.' : 'Request rejected.',
          requestId: request.id,
        },
      });
    reply.code(500);
    app.log.error(requestEvent(request, reply, 'INTERNAL_ERROR'), 'Resource request failed');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
        requestId: request.id,
      },
    });
  });
  const checkins = checkInService(db, config);
  const challenges = loginChallengeService(config, db, identity, otpDelivery(), {
    setCheckIn: (user, storeId, transaction) => checkins.set(user, storeId, null, transaction),
  });
  const sessions = config.DEMO_MODE ? memorySessions() : mysqlSessions(db);
  const auth = registerAuth(app, config, identity, demoUser, sessions, challenges);
  const profileStore = config.DEMO_MODE
    ? undefined
    : createScopedMediaStore(config, readPrivateS3Options(), 'uploads/users', {
        image: 'profile_image',
        'cover-image': 'cover_image',
      });
  const profiles = profileService(config, db, { imagesAvailable: Boolean(profileStore) });
  registerOperatorBinding(app);
  registerProfile(app, profiles, identity, auth.rotateSession);
  registerProfileMedia(app, profileMediaService(config, db, profileStore), profiles);
  const handoffOptions = deviceHandoffOptions();
  const handoffStore =
    !config.DEMO_MODE &&
    handoffOptions.POS_DEVICE_HANDOFF_REDIS_URL &&
    handoffOptions.UPSTREAM_POS_DEVICE_HANDOFF_CONTRACT &&
    handoffOptions.POS_DEVICE_HANDOFF_SERVICE_KEY
      ? redisDeviceHandoffStore(config, handoffOptions.POS_DEVICE_HANDOFF_REDIS_URL)
      : undefined;
  registerDeviceHandoffs(app, deviceHandoffService(config, db, handoffOptions, handoffStore));
  const productSync = productSynchronizer(
    config.DEMO_MODE
      ? undefined
      : createProductSyncAdapter(config, readAdministrationWorkerOptions(), fetch, {
          requireReplaySafe: false,
        }),
    (level, event, message) => app.log[level](event, message),
  );
  const stockProjection = configuredStockProjection(config);
  const mediaStore = config.DEMO_MODE
    ? undefined
    : createDocumentationMediaStore(config, readDocumentationMediaOptions());
  const storeImageStore = config.DEMO_MODE
    ? undefined
    : createStoreImageStore(config, readPrivateS3Options());
  const settingsOptions = config.DEMO_MODE ? undefined : readSettingsOptions();
  const settingsDelivery = settingsOptions
    ? createSettingsDelivery(config, db, settingsOptions)
    : undefined;
  app.addHook('onClose', async () => {
    profileStore?.close();
    mediaStore?.close();
    storeImageStore?.close();
    await handoffStore?.close();
    await settingsDelivery?.close?.();
  });
  registerAdministration(app, config, db, {
    ...(stockProjection ? { procedureVerified: true, stockProcedure: stockProjection } : {}),
    slackOAuth: createSlackOAuthProvider(config, readSlackOAuthOptions()),
    productSync,
    moduleRuntime,
    csvStorage: createCsvUploadStorage(config, readPrivateS3Options()),
    mediaStore,
    storeImageStore,
    operatorImageStore: profileStore,
    settingsDelivery,
    ecommerceCooldownSeconds: settingsOptions?.ECOM_DELIVERY_CHANGES_TIME,
  });
  const customerOtpOptions = readCustomerOtpOptions(),
    customerOtp = customerOtpService(
      config,
      db,
      customerOtpOptions,
      createCustomerOtpDelivery(config, customerOtpOptions),
    );
  registerBarcodeAssignments(app, config, db, moduleRuntime.ephemeral);
  registerOperatorModelAccounts(app, config, db);
  registerSecondaryCountrySearch(app, db);
  const wholeOrderOptions = readWholeOrderStatusOptions(config.DEMO_MODE ? {} : process.env);
  const checkout = await registerCheckout(app, config, db, {
    environment: checkoutRuntime,
    paymentCorrections: paymentCorrectionEvidence(paymentCorrections.proofKey ?? ''),
    customerOtp,
    orderCopy: { history: historicalOrderCopyFacts(orderHistory) },
    rejectedInboundRepairDispatcherEnabled:
      !config.DEMO_MODE && wholeOrderOptions.WHOLE_ORDER_STATUS_WORKER_ENABLED,
    ...(stockProjection
      ? { inventoryProcedureVerified: true, stockProcedure: stockProjection }
      : {}),
  });
  registerOfflineSync(app, config, db, { checkout, identity, environment: checkoutRuntime });
  registerPaymentReversals(app, config, db, {
    ...paymentReversalOptions(),
    hashSecret: paymentCorrections.proofKey ?? '',
    projection: checkoutRuntime,
  });
  await registerGlobalVouchers(app, config, db, readGlobalVoucherOptions(), { customerOtp });
  registerCustomerWebsiteHandoff(app, config, db, customerOtp);
  await registerFulfillment(app, config, db);
  registerShippingLabels(app, db);
  registerLegacyFulfillment(app, config, db);
  await registerWholeOrderStatus(app, config, db, wholeOrderOptions);
  registerCustomerWorkspace(app, config, db);
  registerCustomerHistory(app, config, db);
  registerProductFeedback(app, config, db);
  registerCheckoutPerformance(app, config, db);
  registerInvoiceDocuments(app, config, db);
  registerCustomerContacts(app, config, db, readCustomerContactOptions());
  await registerFinance(app, config, db, {
    paymentCorrections,
    ...(config.DEMO_MODE ? { demoStores: services.catalog.stores } : {}),
  });
  await registerOperationalReports(app, config, db);
  await registerCatalogDetails(app, config, db);
  registerSpecialPermissionHistory(app, config, db, readSpecialPermissionHistoryOptions());
  registerApplicationLinks(app, config, db);
  registerMotivationalQuotes(app);
  registerDashboard(app, config, db);
  registerGiftCardBatches(app, config, db, readGiftCardBatchOptions());
  registerAdministrationHistory(app, config, db, readAdministrationHistoryOptions());
  app.get('/api/v1/reports/daily-store-sales', async (request) => {
    const user = authenticated(request);
    const input = z
      .object({
        storeIds: z
          .string()
          .max(10000)
          .transform((value) => z.array(identifier).min(1).max(500).parse(value.split(','))),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .strict()
      .parse(request.query);
    if (!config.DEMO_MODE) return reports.daily(user, input);
    const storeIds = scopedStores(user, input.storeIds),
      range = dailyReportRange(input, config.BUSINESS_TIMEZONE);
    const data = mergeDailyRows(
      storeIds.map((storeId) => ({
        store_id: Number(storeId),
        store_name: storeId === '1' ? 'Bandra Flagship' : 'Indiranagar',
        location_code: `DEMO-${storeId}`,
        order_date: input.from,
        order_count: 18,
        qty: 27,
        revenue: 24680.5,
        membership_purchase_orders: 2,
        membership_orders_total: 5,
        membership_revenue: 8100,
        tss_money_used_total: 250,
        tss_points_used_total: 320,
        pg_discount_total: 480,
        gift_voucher_total: 0,
        district_total: 1200,
        cash_total: 6400,
        total_online: 17080.5,
      })),
      [],
      { footfall: {}, target: {}, banking: {} },
    );
    return {
      reader: routeRead({ kind: 'report', range }, undefined, config.BUSINESS_TIMEZONE),
      range,
      data,
      totals: dailyTotals(data),
    };
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    if (config.DEMO_MODE) return { status: 'ok', mode: 'demo' };
    const result = await Promise.allSettled([
      ...(['writer', 'primary', 'data'] as const).map(async (reader) =>
        db.get(reader).execute(sql`SELECT 1`),
      ),
      assertMigrationsCurrent(db),
    ]);
    const ready = result.every((value) => value.status === 'fulfilled');
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'unavailable',
      mode: 'live',
      dependencies: Object.fromEntries(
        (['writer', 'primary', 'data', 'migrations'] as const).map((reader, index) => [
          reader,
          result[index]!.status === 'fulfilled' ? 'available' : 'unavailable',
        ]),
      ),
    });
  });
  app.get('/api/v1/stores', async (request) => ({
    data: await services.catalog.stores(authenticated(request)),
  }));
  app.get('/api/v1/stores/:storeId/counters', async (request) => {
    const q = scope.parse(request.params);
    return { data: await services.catalog.counters(authenticated(request), q.storeId) };
  });
  app.get('/api/v1/stores/:storeId/catalog/products', async (request) => {
    const { storeId } = scope.parse(request.params);
    const q = z
      .object({
        search: z.string().max(100).default(''),
        after: cursor.default('0'),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        includeOutOfStock: z
          .enum(['true', 'false'])
          .default('false')
          .transform((value) => value === 'true'),
      })
      .strict()
      .parse(request.query);
    return services.catalog.products(
      authenticated(request),
      storeId,
      q.search,
      q.after,
      q.limit,
      q.includeOutOfStock,
    );
  });
  app.get(
    '/api/v1/stores/:storeId/catalog/products/by-barcode/:barcode',
    { config: { trace: { module: 'catalog', resource: 'barcode-product', action: 'read' } } },
    async (request, reply) => {
      const user = authenticated(request);
      const params = scope.extend({ barcode: catalogBarcode }).strict().parse(request.params);
      z.object({}).strict().parse(request.query);
      if (request.headers['x-operator-id'] !== user.id)
        throw new AppError(
          409,
          'OPERATOR_CHANGED',
          'The active operator changed. Refresh this workspace.',
        );
      if (!request.authSessionValid || !(await request.authSessionValid()))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      const result = await readCatalogBarcode(
        services.catalog,
        config.DEMO_MODE ? null : db,
        user,
        params.storeId,
        params.barcode,
      );
      if (!(await request.authSessionValid()))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      return reply.header('Cache-Control', 'private, no-store').send(result);
    },
  );
  registerPublicOrders(app, services.orders);
  registerOnlineOrderDetails(app, config, db);
  await registerOrderSearch(
    app,
    config,
    db,
    readOrderSearchOptions(),
    config.DEMO_MODE ? { service: demoOrderSearch(config, services.catalog, services.orders) } : {},
  );
  app.get('/api/v1/stores/:storeId/cart-drafts', async (request) => {
    const q = scope.parse(request.params);
    return { data: await services.drafts.list(authenticated(request), q.storeId) };
  });
  app.put('/api/v1/stores/:storeId/cart-drafts/:draftId', async (request) => {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Sign back in before syncing this sale.',
      );
    const params = scope.extend({ draftId: z.uuid() }).parse(request.params);
    const input = draftMutationSchema.parse(request.body);
    if (params.storeId !== input.draft.storeId || params.draftId !== input.draft.id)
      throw new AppError(400, 'SCOPE_MISMATCH', 'Cart identity must match its resource path.');
    return services.drafts.save(user, input);
  });
  return app;
}
