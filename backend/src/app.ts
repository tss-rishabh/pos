import Fastify, { LogController, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { Config } from './config.js';
import { createDatabases } from './db/pools.js';
import { configuredStockProjection } from './db/stock-projection/options.js';
import { identityService } from './auth/identity.js';
import { registerAuth, authenticated } from './auth/routes.js';
import { AppError } from './domain/errors.js';
import {
  catalogBarcode,
  readCatalogBarcode,
  registerCatalogStockLocations,
} from './modules/catalog-barcode.js';
import { activeAccountReader, redisSessions } from './auth/sessions.js';
import { loginChallengeService } from './auth/mfa.js';
import {
  liveLoginOtpTransport,
  loginDeliveryOptions,
  loginOtpDelivery,
  sandboxLoginOtpTransport,
} from './auth/delivery.js';
import { authEventLogger } from './auth/events.js';
import { fixedOtpSettings, loginOtpState } from './auth/login-otp.js';
import { pendingLogins } from './auth/login-pending.js';
import { loginCheckIns, storeDirectory } from './auth/checkin.js';
import { connectRedisPort, unavailableRedisPort } from './redis/node-client.js';
import type { RedisPort } from './redis/port.js';
import { profileService } from './auth/profile.js';
import { registerProfile } from './auth/profile-routes.js';
import { profileMediaService } from './auth/profile-media.js';
import { deviceHandoffOptions, deviceHandoffService } from './auth/device-handoff.js';
import { redisDeviceHandoffStore } from './auth/device-handoff-store.js';
import { registerDeviceHandoffs } from './auth/device-handoff-routes.js';
import { registerProfileMedia } from './auth/profile-media-routes.js';
import { bindCheckInRedis } from './modules/administration/checkins.js';
import { useAdministrationEphemeralStore } from './modules/administration/ephemeral-runtime.js';
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
import { configuredStateStore } from './modules/checkout/state-store.js';
import { checkoutSessionStore } from './modules/checkout/session-store.js';
import { registerOfflineSync } from './modules/offline-sync/index.js';
import {
  readWholeOrderStatusOptions,
  registerWholeOrderStatus,
} from './modules/legacy-order-status/index.js';
import { checkoutEnvironment } from './modules/checkout/gateway.js';
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
import { customerOtpService, readCustomerOtpOptions } from './modules/customer-otp/index.js';
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
import { registerOrderSearch } from './modules/order-history/search/index.js';
import { draftMutationSchema, draftService } from './modules/drafts.js';
import { registerEventCatalog, requestEvent } from './observability/events.js';
import { createModuleRuntime } from './jobs/module-runtime.js';
import { registerRequestTrace, requestIdFor, tracedFetch } from './observability/context.js';
import { installOutboundAllowlist } from './outbound/allowlist.js';
import { databaseRecipientDirectory } from './outbound/recipients.js';
import { identifier, cursor } from './domain/validation.js';
import {
  noQuery,
  operatorHeaders,
  registerRouteValidation,
  routeSchema,
  transportHeaders,
} from './domain/route-validation.js';
import { mapError } from './observability/errors.js';
import { applicationLogger } from './observability/logger.js';
import { reportService } from './modules/reports.js';
import { sql } from 'drizzle-orm';
import type { JobProducer } from './jobs/contract.js';
import { nodeOrderRedis } from './modules/fulfillment/order-redis.js';

const id = identifier;
const scope = z.object({ storeId: id });
class PrivateLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
export async function buildApp(
  config: Config,
  options: {
    logger?: FastifyServerOptions['logger'];
    authRedis?: RedisPort;
    /** Overrides the Redis job-queue producer (tests); otherwise built from REDIS_URL. */
    jobs?: JobProducer;
  } = {},
) {
  const logger = options.logger
    ? applicationLogger(typeof options.logger === 'object' ? options.logger : {})
    : false;
  const app = Fastify({
    logger,
    bodyLimit: 256_000,
    requestTimeout: 15000,
    connectionTimeout: 10000,
    genReqId: requestIdFor,
    logController: new PrivateLogController(),
    trustProxy: config.TRUSTED_PROXY_CIDRS.length ? config.TRUSTED_PROXY_CIDRS : false,
  });
  registerRouteValidation(app);
  registerEventCatalog(app);
  registerRequestTrace(app);
  await app.register(cookie);
  await app.register(cors, {
    origin: new URL(config.WEB_ORIGIN).origin,
    credentials: true,
    // Lets a cross-origin web client read the request reference it shows on errors.
    exposedHeaders: ['X-Request-Id'],
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: config.API_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });
  const authEvents = authEventLogger(app.log);
  // Legacy redis_instance database 0: sessions, login OTP state, check-in lists, mPOS QR.
  const authRedis =
    options.authRedis ??
    (config.REDIS_URL
      ? connectRedisPort(config.REDIS_URL, config.NODE_ENV)
      : unavailableRedisPort());
  // Check-ins are the legacy `check_in_{uid}` / `check_in_list_{store}` keys login writes.
  bindCheckInRedis(authRedis);
  const db = createDatabases(config),
    identity = identityService(config, db, authEvents);
  // UAT outbound-recipient allowlist (w25-allowlist.md): one guard for every sender.
  installOutboundAllowlist({
    allowlist: config.outboundAllowlist,
    log: app.log,
    directory: databaseRecipientDirectory(db),
  });
  /**
   * Job producer (src/jobs, phase-c-legacy-jobs.md §4) + ephemeral Redis state. `jobs` is the
   * Redis queue producer when REDIS_URL is set (or `options.jobs` in tests),
   * otherwise `undefined`, so optional producers keep their "queue unavailable" handling.
   */
  const moduleRuntime = createModuleRuntime(config, options.jobs),
    jobs = moduleRuntime.queue;
  useAdministrationEphemeralStore(moduleRuntime.ephemeral);
  // W4: one Redis-backed store for checkout, returns and payments state, sharing the producer.
  const posState = configuredStateStore(config),
    checkoutShared = { stateStore: posState, sessions: checkoutSessionStore(posState), jobs };
  app.addHook('onClose', async () => {
    await posState.close();
  });
  const paymentCorrections = paymentCorrectionFinanceOptions(),
    checkoutRuntime = checkoutEnvironment(),
    reports = reportService(config, db, { paymentCorrections }),
    orderHistory = publicOrderHistory(config);
  const services = {
    catalog: catalogService(db),
    orders: ordersService(db, config),
    drafts: draftService(db, posState),
  };
  const orderRedis = nodeOrderRedis(config);
  app.addHook('onClose', async () => {
    await identity.close();
    await orderRedis.close();
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
  });
  // Error codes for the completion event; the request object never reaches the log.
  const errorCodes = new WeakMap<object, string>();
  app.addHook('onResponse', async (request, reply) => {
    app.log.info(
      requestEvent(request, reply, errorCodes.get(request)),
      'Resource request completed',
    );
  });
  // Fastify's default 404 body echoes the method and URL (query values included).
  app.setNotFoundHandler(async (request, reply) => {
    errorCodes.set(request, 'NOT_FOUND');
    return reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
        requestId: request.id,
      },
    });
  });
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, request.id);
    errorCodes.set(request, mapped.logCode);
    reply.code(mapped.status);
    if (mapped.unexpected)
      app.log.error(requestEvent(request, reply, mapped.logCode), 'Resource request failed');
    return reply.send(mapped.body);
  });
  const sessions = redisSessions(config, activeAccountReader(db), authRedis);
  const deliveryOptions = loginDeliveryOptions(process.env, config.NODE_ENV);
  const otpDelivery = loginOtpDelivery(
    deliveryOptions.mode === 'live'
      ? liveLoginOtpTransport(deliveryOptions)
      : sandboxLoginOtpTransport(),
    authEvents,
    deliveryOptions.SERVICE_NAME,
  );
  const loginCheckIn = loginCheckIns(storeDirectory(db), authRedis);
  const challenges = loginChallengeService(
    config,
    identity,
    pendingLogins(authRedis, config.LOGIN_MFA_PENDING_TTL),
    loginOtpState(authRedis, config),
    otpDelivery,
    fixedOtpSettings(),
    authEvents,
    { checkIn: loginCheckIn },
  );
  registerAuth(app, {
    config,
    identity,
    sessions,
    challenges,
    checkIns: loginCheckIn,
    log: authEvents,
  });
  app.addHook('onClose', async () => {
    await otpDelivery.drain();
    await authRedis.close();
  });
  const profileStore = createScopedMediaStore(config, readPrivateS3Options(), 'uploads/users', {
    image: 'profile_image',
    'cover-image': 'cover_image',
  });
  const profiles = profileService(config, db, { imagesAvailable: Boolean(profileStore) });
  registerProfile(app, profiles, identity, sessions);
  registerProfileMedia(app, profileMediaService(config, db, profileStore, authRedis), profiles);
  const handoffOptions = deviceHandoffOptions();
  const handoffStore =
    handoffOptions.UPSTREAM_POS_DEVICE_HANDOFF_CONTRACT &&
    handoffOptions.POS_DEVICE_HANDOFF_SERVICE_KEY
      ? redisDeviceHandoffStore(authRedis)
      : undefined;
  registerDeviceHandoffs(
    app,
    deviceHandoffService(config, db, handoffOptions, handoffStore, identity),
  );
  // Legacy `Helpers.sync_pos_product`: one unretried POST after commit, failures only logged.
  const productSyncAdapter = createProductSyncAdapter(
      config,
      readAdministrationWorkerOptions(),
      tracedFetch,
      { requireReplaySafe: false },
    ),
    productSync = productSynchronizer(productSyncAdapter, (level, event, message) =>
      app.log[level](event, message),
    );
  const stockProjection = configuredStockProjection(config);
  const mediaStore = createDocumentationMediaStore(config, readDocumentationMediaOptions());
  const storeImageStore = createStoreImageStore(config, readPrivateS3Options());
  const settingsOptions = readSettingsOptions();
  const settingsDelivery = createSettingsDelivery(config, db, settingsOptions);
  app.addHook('onClose', async () => {
    profileStore?.close();
    mediaStore?.close();
    storeImageStore?.close();
    await settingsDelivery?.close?.();
  });
  registerAdministration(app, config, db, {
    ephemeral: moduleRuntime.ephemeral,
    ...(stockProjection ? { procedureVerified: true, stockProcedure: stockProjection } : {}),
    slackOAuth: createSlackOAuthProvider(config, readSlackOAuthOptions()),
    productSync,
    moduleRuntime,
    csvStorage: createCsvUploadStorage(config, readPrivateS3Options()),
    mediaStore,
    storeImageStore,
    operatorImageStore: profileStore,
    operatorImageReservations: authRedis,
    settingsDelivery,
    ecommerceCooldownSeconds: settingsOptions.ECOM_DELIVERY_CHANGES_TIME,
  });
  const customerOtpOptions = readCustomerOtpOptions(),
    customerOtp = customerOtpService(config, db, customerOtpOptions, checkoutShared);
  registerBarcodeAssignments(app, config, db, moduleRuntime.ephemeral);
  registerOperatorModelAccounts(app, config, db);
  registerSecondaryCountrySearch(app, db);
  const wholeOrderOptions = readWholeOrderStatusOptions(process.env);
  const checkout = await registerCheckout(app, config, db, {
    ...checkoutShared,
    environment: checkoutRuntime,
    customerOtp,
    orderCopy: { history: historicalOrderCopyFacts(orderHistory) },
    ...(productSyncAdapter ? { syncProducts: productSyncAdapter } : {}),
    ...(stockProjection
      ? { inventoryProcedureVerified: true, stockProcedure: stockProjection }
      : {}),
  });
  registerOfflineSync(app, config, db, { checkout, identity, environment: checkoutRuntime });
  await registerGlobalVouchers(app, config, db, readGlobalVoucherOptions(), {
    ...checkoutShared,
    customerOtp,
  });
  registerCustomerWebsiteHandoff(app, config, db);
  await registerFulfillment(app, config, db, { redis: orderRedis, jobs });
  registerShippingLabels(app, db);
  registerLegacyFulfillment(app, config, db, {
    jobs,
    redis: orderRedis,
    ...(productSyncAdapter ? { dependencies: { syncProducts: productSyncAdapter } } : {}),
  });
  await registerWholeOrderStatus(app, config, db, wholeOrderOptions);
  registerCustomerWorkspace(app, config, db, orderRedis);
  registerCustomerHistory(app, config, db);
  registerProductFeedback(app, config, db, orderRedis);
  registerCheckoutPerformance(app, config, db, checkoutShared);
  registerInvoiceDocuments(app, config, db);
  registerCustomerContacts(app, config, db);
  await registerFinance(app, config, db, {
    ephemeral: moduleRuntime.ephemeral,
    paymentCorrections,
  });
  await registerOperationalReports(app, config, db, { jobs: moduleRuntime.jobs });
  await registerCatalogDetails(app, config, db, { ephemeral: moduleRuntime.ephemeral });
  registerCatalogStockLocations(app, db);
  registerSpecialPermissionHistory(app, config, db, readSpecialPermissionHistoryOptions());
  registerApplicationLinks(app, config, db, moduleRuntime);
  registerDashboard(app, config, db);
  registerGiftCardBatches(app, config, db, readGiftCardBatchOptions(), moduleRuntime);
  registerAdministrationHistory(app, config, db, readAdministrationHistoryOptions());
  const dailyStoreSalesQuery = z
    .object({
      storeIds: z
        .string()
        .max(10000)
        .transform((value) => z.array(identifier).min(1).max(500).parse(value.split(','))),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict();
  app.get(
    '/api/v1/reports/daily-store-sales',
    routeSchema({ querystring: dailyStoreSalesQuery, headers: transportHeaders }),
    async (request) => {
      const user = authenticated(request);
      return reports.daily(user, dailyStoreSalesQuery.parse(request.query));
    },
  );
  const noInput = routeSchema({ querystring: noQuery, headers: transportHeaders });
  const health = { config: { authentication: 'public' as const }, ...noInput };
  app.get('/health/live', health, async () => ({ status: 'ok' }));
  app.get('/health/ready', health, async (_request, reply) => {
    const result = await Promise.allSettled([
      ...(['writer', 'primary', 'data'] as const).map(async (reader) =>
        db.get(reader).execute(sql`SELECT 1`),
      ),
    ]);
    const ready = result.every((value) => value.status === 'fulfilled');
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'unavailable',
      mode: 'live',
      dependencies: Object.fromEntries(
        (['writer', 'primary', 'data'] as const).map((reader, index) => [
          reader,
          result[index]!.status === 'fulfilled' ? 'available' : 'unavailable',
        ]),
      ),
    });
  });
  app.get('/api/v1/stores', noInput, async (request) => ({
    data: await services.catalog.stores(authenticated(request)),
  }));
  const storeInput = routeSchema({
    params: scope.strict(),
    querystring: noQuery,
    headers: transportHeaders,
  });
  app.get('/api/v1/stores/:storeId/counters', storeInput, async (request) => {
    const q = scope.parse(request.params);
    return { data: await services.catalog.counters(authenticated(request), q.storeId) };
  });
  const catalogProductsQuery = z
    .object({
      search: z.string().max(100).default(''),
      after: cursor.default('0'),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      includeOutOfStock: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    })
    .strict();
  app.get(
    '/api/v1/stores/:storeId/catalog/products',
    routeSchema({
      params: scope.strict(),
      querystring: catalogProductsQuery,
      headers: transportHeaders,
    }),
    async (request) => {
      const { storeId } = scope.parse(request.params);
      const q = catalogProductsQuery.parse(request.query);
      return services.catalog.products(
        authenticated(request),
        storeId,
        q.search,
        q.after,
        q.limit,
        q.includeOutOfStock,
      );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/catalog/products/by-barcode/:barcode',
    {
      config: { trace: { module: 'catalog', resource: 'barcode-product', action: 'read' } },
      ...routeSchema({
        params: scope.extend({ barcode: catalogBarcode }).strict(),
        querystring: noQuery,
        headers: operatorHeaders,
      }),
    },
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
        db,
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
  await registerOrderSearch(app, config, db);
  app.get('/api/v1/stores/:storeId/cart-drafts', storeInput, async (request) => {
    const q = scope.parse(request.params);
    return { data: await services.drafts.list(authenticated(request), q.storeId) };
  });
  app.put(
    '/api/v1/stores/:storeId/cart-drafts/:draftId',
    routeSchema({
      params: scope.extend({ draftId: z.uuid() }).strict(),
      querystring: noQuery,
      body: draftMutationSchema,
      headers: operatorHeaders,
    }),
    async (request) => {
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
    },
  );
  return app;
}
