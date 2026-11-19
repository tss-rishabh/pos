import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  configuredStockProjection,
  configuredSystemStockProjection,
} from '../../db/stock-projection/options.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import {
  noBody,
  noQuery,
  operatorHeaders,
  requestHeaders,
  routeSchema,
} from '../../domain/route-validation.js';
import type { JobProducer } from '../../jobs/contract.js';
import { createProductSyncAdapter } from '../administration/product-sync.js';
import { readAdministrationWorkerOptions } from '../administration/worker-options.js';
import { notificationBus } from '../fulfillment/notification-bus.js';
import { nodeOrderRedis, type OrderRedis } from '../fulfillment/order-redis.js';
import { legacyFulfillmentActions, type LegacyFulfillmentActions } from './actions.js';
import { hyperlocalGateway } from './gateway.js';
import { credentialMatches, readLegacyFulfillmentOptions } from './options.js';
import {
  lifecycleRuntime,
  type LegacyFulfillmentDependencies,
  type LifecycleLog,
} from './runtime.js';
export { registerJobHandlers } from './jobs.js';
export type { LegacyFulfillmentDependencies } from './runtime.js';

interface EventLogger {
  info(object: object, message: string): void;
}
/**
 * Builds the module dependencies from the environment. Used by the HTTP registration below and
 * by the jobs worker (`registerJobHandlers(registry, legacyFulfillmentDependencies(...))`).
 */
export function legacyFulfillmentDependencies(
  config: Config,
  db: Databases,
  supplied: {
    jobs?: JobProducer;
    redis?: OrderRedis;
    logger?: EventLogger;
    environment?: NodeJS.ProcessEnv;
  } & Partial<LegacyFulfillmentDependencies> = {},
): LegacyFulfillmentDependencies & { close(): Promise<void> } {
  const environment = supplied.environment ?? process.env,
    env = supplied.env ?? readLegacyFulfillmentOptions(environment),
    redis = supplied.redis ?? nodeOrderRedis(config),
    commonRedis =
      supplied.commonRedis ??
      (env.COMMON_REDIS_URL
        ? nodeOrderRedis({ REDIS_URL: env.COMMON_REDIS_URL, NODE_ENV: config.NODE_ENV })
        : undefined),
    bus = supplied.publish ? undefined : notificationBus(config),
    logger = supplied.logger,
    log: LifecycleLog =
      supplied.log ??
      ((event) =>
        logger?.info(
          {
            module: 'legacy-fulfillment',
            resource: 'local-delivery',
            eventId: event.eventId,
            eventInstanceId: crypto.randomUUID(),
            outcome: event.outcome,
            ...(event.status !== undefined ? { status: event.status } : {}),
          },
          'Local delivery step',
        ));
  const stockProcedure = supplied.stockProcedure ?? configuredStockProjection(config, environment);
  const systemStockProcedure =
    supplied.systemStockProcedure ?? configuredSystemStockProjection(config, environment);
  const syncProducts =
    supplied.syncProducts ??
    createProductSyncAdapter(config, readAdministrationWorkerOptions(environment));
  return {
    config,
    db,
    env,
    gateway: supplied.gateway ?? hyperlocalGateway(config, env),
    redis,
    ...(commonRedis ? { commonRedis } : {}),
    ...(supplied.jobs ? { jobs: supplied.jobs } : {}),
    ...(stockProcedure ? { stockProcedure } : {}),
    ...(systemStockProcedure ? { systemStockProcedure } : {}),
    ...(syncProducts ? { syncProducts } : {}),
    ...(supplied.publish
      ? { publish: supplied.publish }
      : bus
        ? { publish: (event) => bus.publish(event) }
        : {}),
    ...(supplied.clock ? { clock: supplied.clock } : {}),
    log,
    async close() {
      if (!supplied.commonRedis) await commonRedis?.close();
      await bus?.close();
    },
  };
}

const formFields = (body: string) => {
  const params = new URLSearchParams(body),
    values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in values || Object.keys(values).length >= 16) throw new Error('Invalid service body');
    values[key] = value;
  }
  return values;
};
/** Django `request.POST.get(name)` truthiness: any non-empty value (even "0") is true. */
const postFlag = z
  .string()
  .max(32)
  .optional()
  .transform((value) => Boolean(value));
const sourceId = z.string().regex(/^[1-9]\d{0,18}$/);

export function registerLegacyFulfillment(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: {
    jobs?: JobProducer;
    redis?: OrderRedis;
    dependencies?: Partial<LegacyFulfillmentDependencies> & { environment?: NodeJS.ProcessEnv };
    actions?: LegacyFulfillmentActions;
  } = {},
) {
  const deps = legacyFulfillmentDependencies(config, db, {
    ...options.dependencies,
    ...(options.jobs ? { jobs: options.jobs } : {}),
    ...(options.redis ? { redis: options.redis } : {}),
    logger: app.log,
  });
  app.addHook('onClose', async () => deps.close());
  const runtime = lifecycleRuntime(deps),
    actions = options.actions ?? legacyFulfillmentActions(runtime);
  const params = z.object({ storeId: identifier, orderId: identifier }).strict(),
    empty = z.object({}).strict(),
    note = z.object({ note: z.string().trim().min(1).max(200) }).strict(),
    cancellationBody = z.object({ reason: z.string().trim().min(1).max(200) }).strict(),
    transferBody = z
      .object({
        reason: z.string().trim().min(1).max(200),
        reasonDropdown: z.enum([
          'Product not available at store',
          'Packaging material not available at store',
          'Printer not available at store',
          'Bandwidth issue at store',
        ]),
      })
      .strict(),
    trace = (resource: string, action: string, body?: z.ZodType) => ({
      config: { trace: { module: 'legacy-fulfillment', resource, action } },
      ...routeSchema({
        params,
        querystring: empty,
        ...(body ? { body } : {}),
        headers: operatorHeaders,
      }),
    });
  const actor = (request: FastifyRequest) => {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Sign back in before continuing.',
      );
    empty.parse(request.query);
    return user;
  };
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'private, no-store');
  const base = '/api/v1/stores/:storeId/legacy-fulfillment/orders/:orderId',
    lifecycle = '/api/v1/stores/:storeId/local-deliveries/orders/:orderId';

  app.get(base, trace('legacy-order', 'read'), async (request, reply) => {
    const user = actor(request),
      value = params.parse(request.params);
    noStore(reply);
    return { data: await actions.status(user, value.storeId, value.orderId) };
  });
  app.put(base + '/packing', trace('legacy-packing', 'create', note), async (request, reply) => {
    const user = actor(request),
      value = params.parse(request.params),
      input = note.parse(request.body);
    noStore(reply);
    return actions.pack(user, value.storeId, value.orderId, input.note);
  });
  app.post(
    base + '/rto-receipts',
    trace('legacy-rto-receipt', 'create', note),
    async (request, reply) => {
      const user = actor(request),
        value = params.parse(request.params),
        input = note.parse(request.body);
      noStore(reply);
      return actions.receiveRto(user, value.storeId, value.orderId, input.note);
    },
  );
  app.post(
    lifecycle + '/courier-requests',
    trace('courier-request', 'create', noBody),
    async (request, reply) => {
      const user = actor(request),
        value = params.parse(request.params);
      empty.parse(request.body ?? {});
      noStore(reply);
      return actions.create(user, value.storeId, value.orderId);
    },
  );
  app.post(
    lifecycle + '/cancellations',
    trace('delivery-cancellation', 'create', cancellationBody),
    async (request, reply) => {
      const user = actor(request),
        value = params.parse(request.params),
        input = cancellationBody.parse(request.body);
      noStore(reply);
      return actions.cancel(user, value.storeId, value.orderId, input.reason);
    },
  );
  app.post(
    lifecycle + '/transfers',
    trace('delivery-transfer', 'create', transferBody),
    async (request, reply) => {
      const user = actor(request),
        value = params.parse(request.params),
        input = transferBody.parse(request.body);
      noStore(reply);
      return actions.pass(user, value.storeId, value.orderId, input.reason, input.reasonDropdown);
    },
  );
  app.post(
    lifecycle + '/online-conversions',
    trace('online-conversion', 'create', noBody),
    async (request, reply) => {
      const user = actor(request),
        value = params.parse(request.params);
      empty.parse(request.body ?? {});
      noStore(reply);
      return actions.convert(user, value.storeId, value.orderId);
    },
  );

  // Service webhooks, served at the legacy paths (order.urls is mounted at `orders/` and
  // `api/v1/orders/`, POSAdmin/urls.py:16-17) with the legacy form body and APPID/APPKEY headers.
  const service = (kind: 'arrival' | 'cancellation') => ({
    ...routeSchema({ querystring: noQuery, body: serviceForm, headers: credentials }),
    config: {
      authentication: 'service' as const,
      trace: {
        module: 'legacy-fulfillment',
        resource: kind === 'arrival' ? 'delivery-arrival' : 'delivery-observer-cancellation',
        action: 'receive',
      },
    },
  });
  const credentials = requestHeaders({
    appid: z.string().max(1024).optional(),
    appkey: z.string().max(1024).optional(),
  });
  /**
   * The integration parser hands handlers the form fields (`formFields`, at most 16 string
   * values; `null` without a body). Legacy reads only the named `request.POST` keys and ignores
   * any other field the sender adds, so the handlers below keep their passthrough parses.
   */
  const serviceForm = z.record(z.string().max(4096), z.string().max(4096)).nullable();
  const arrival = z
    .object({ order_id: sourceId, location_id: sourceId, is_notify: postFlag })
    .passthrough();
  const cancellation = z
    .object({
      order_id: sourceId,
      store_id: z.string().regex(/^\d{1,19}$/),
      platform: z.string().max(32).optional(),
      is_notify: postFlag,
      title: z.string().max(200).optional(),
    })
    .passthrough();
  app.register(async (integration) => {
    integration.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_request, body, done) => {
        try {
          if (typeof body !== 'string') throw new Error('Invalid service body');
          done(null, formFields(body));
        } catch {
          done(new AppError(400, 'INVALID_SERVICE_BODY', 'Invalid delivery event body.'));
        }
      },
    );
    for (const prefix of ['/orders', '/api/v1/orders']) {
      integration.post(prefix + '/auto-hl-order/', service('arrival'), async (request, reply) => {
        const headers = credentials.parse(request.headers);
        if (
          !credentialMatches(deps.env.APP_ID, headers.appid) ||
          !credentialMatches(deps.env.APP_KEY, headers.appkey)
        )
          return reply.code(401).send({ status: '401', message: 'Authentication Failed' });
        const input = arrival.parse(request.body ?? {});
        await actions.lifecycle.arrival(input.order_id, input.location_id, input.is_notify);
        return reply.send({ status: '200', message: 'Order Creation is in progress' });
      });
      integration.post(
        prefix + '/webhook-cancelled-order/',
        service('cancellation'),
        async (request, reply) => {
          const headers = credentials.parse(request.headers);
          if (
            !credentialMatches(deps.env.TSS_OBERVER_APP_ID, headers.appid) ||
            !credentialMatches(deps.env.TSS_OBERVER_APP_KEY, headers.appkey)
          )
            return reply.code(401).send({ status: '401', message: 'Authentication Failed' });
          const input = cancellation.parse(request.body ?? {});
          await actions.lifecycle.webhookCancel({
            orderId: input.order_id,
            storeId: input.store_id,
            platform: input.platform ?? '',
            notify: input.is_notify,
            title: input.title ?? '',
          });
          // Legacy message is a plain string, not an f-string (`order/views.py:4298`).
          return reply.send({
            status: '200',
            message: 'Order cancelled/refund: {resp} {error_msg}',
          });
        },
      );
    }
  });
  return actions;
}
