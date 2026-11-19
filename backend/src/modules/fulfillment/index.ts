import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { JobHandlerRegistry, JobProducer } from '../../jobs/contract.js';
import { authenticated } from '../../auth/routes.js';
import { identifier, cursor } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { requireRole, requireStore } from '../../domain/access.js';
import { expressStatusSchema, fulfillmentTabSchema } from './domain.js';
import { notificationBus, type NotificationBus } from './notification-bus.js';
import { notificationStream } from './notification-stream.js';
import { fulfillmentService, type FulfillmentService } from './service.js';
import {
  readFulfillmentOptions,
  secretMatches,
  verifyWebhookCredentials,
  type FulfillmentOptions,
} from './options.js';
import { fulfillmentEffects, fulfillmentLogger, type FulfillmentEffects } from './effects.js';
import { redisCheckIns, type CheckInReader } from './checkin.js';
import type { OrderRedis } from './order-redis.js';
import { fulfillmentMonitoring, monitorTabSchema, monitorTabs } from './monitoring.js';
import {
  enqueueAdvanceOrderNotification,
  enqueueAutoReject,
  registerJobHandlers as registerFulfillmentJobHandlers,
} from './jobs.js';

export { createOrderNotification } from './notifications.js';
export { fulfillmentEffects } from './effects.js';
export { enqueueAdvanceOrderNotification } from './jobs.js';

const scope = z.object({ storeId: identifier }),
  orderScope = scope.extend({ orderId: identifier });
const trace = (resource: string, action: string) => ({
  trace: { module: 'fulfillment', resource, action },
});
interface RegistrationOptions {
  /** Shared order Redis (legacy check-in keys, `express_reject_lock:*`). */
  redis: OrderRedis;
  /** Job-queue producer; undefined until the jobs workstream wires the queue. */
  jobs?: JobProducer;
  service?: FulfillmentService;
  bus?: NotificationBus;
  credentials?: FulfillmentOptions;
  effects?: FulfillmentEffects;
  checkins?: CheckInReader;
  fetch?: typeof fetch;
}
function assertOperator(request: FastifyRequest) {
  const user = authenticated(request);
  if (request.headers['x-operator-id'] !== user.id)
    throw new AppError(
      409,
      'OPERATOR_CHANGED',
      'The signed-in operator changed. Sign back in before continuing.',
    );
  return user;
}
/** Legacy `request.POST` for `application/x-www-form-urlencoded` bodies. */
function formField(body: unknown, request: FastifyRequest, name: string): string | null {
  const type = String(request.headers['content-type'] || '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (type !== 'application/x-www-form-urlencoded' || typeof body !== 'string') return null;
  const value = new URLSearchParams(body).get(name);
  return value === null || value === '' ? null : value;
}

/**
 * Handlers for O1 and O5, built from the same dependencies the routes use. W8 calls this with
 * the worker registry (`backend/src/jobs/contract.ts`).
 */
export function registerJobHandlers(
  registry: JobHandlerRegistry,
  deps: {
    config: Config;
    db: Databases;
    redis: OrderRedis;
    log: (
      level: 'info' | 'warn' | 'error',
      event: Record<string, unknown>,
      message: string,
    ) => void;
    credentials?: FulfillmentOptions;
    bus?: NotificationBus;
    fetch?: typeof fetch;
  },
) {
  const credentials = deps.credentials ?? readFulfillmentOptions(),
    log = fulfillmentLogger(deps.log),
    effects = fulfillmentEffects(deps.db, credentials, {
      log,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    checkins = redisCheckIns(deps.redis);
  registerFulfillmentJobHandlers(registry, {
    expiry: {
      config: deps.config,
      db: deps.db,
      options: credentials,
      redis: deps.redis,
      effects,
      log,
    },
    notifications: {
      config: deps.config,
      db: deps.db,
      checkins,
      effects,
      bus: deps.bus ?? notificationBus(deps.config),
      log,
    },
  });
}

export async function registerFulfillment(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: RegistrationOptions,
) {
  const credentials = options.credentials || readFulfillmentOptions(),
    log = fulfillmentLogger((level, event, message) => app.log[level](event, message)),
    effects =
      options.effects ||
      fulfillmentEffects(db, credentials, {
        log,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    checkins = options.checkins || redisCheckIns(options.redis),
    service = options.service || fulfillmentService(config, db, credentials, { checkins, effects }),
    jobs = options.jobs;
  const bus =
    options.bus ||
    notificationBus(config, () =>
      app.log.warn(
        {
          eventId: 'notifications.redis.connection.failed',
          eventInstanceId: randomUUID(),
          module: 'notifications',
          resource: 'redis-connection',
          requestId: null,
          userId: null,
          errorCode: 'REDIS_UNAVAILABLE',
        },
        'Notification connection unavailable',
      ),
    );
  async function requireCurrentCheckIn(
    userId: string,
    storeId: string,
    purpose: 'notifications' | 'expiry reminders',
  ) {
    if ((await checkins.checkedInStore(userId)) !== storeId)
      throw new AppError(403, 'CHECK_IN_REQUIRED', `Check into this store to receive ${purpose}.`);
  }
  const monitoring = fulfillmentMonitoring(config, db, checkins);
  app.addHook('onClose', async () => {
    await bus.close();
    await effects.idle();
  });
  const tabQuery = z
    .object({ tab: z.string().max(32).optional() })
    .strict()
    .transform(({ tab }) => fulfillmentTabSchema.catch('in_queue').parse(tab ?? 'in_queue'));

  // ── Hyperlocal progress (check-in store, `order/views.py:4908-5353`) ──
  app.get(
    '/api/v1/fulfillment/progress',
    { config: trace('express-progress', 'read') },
    async (request) => {
      const user = authenticated(request);
      tabQuery.parse(request.query);
      const storeId = await service.checkInStore(user);
      await enqueueAutoReject(jobs, storeId, log);
      return { ...(await service.progress(user)), pollIntervalMs: credentials.HL_POLL_INTERVAL_MS };
    },
  );
  app.get(
    '/api/v1/fulfillment/progress/orders',
    { config: trace('express-order', 'list') },
    async (request) => {
      const user = authenticated(request),
        query = z
          .object({
            tab: z.string().max(32).optional(),
            offset: z.coerce.number().int().min(0).max(1_000_000).catch(0).default(0),
          })
          .strict()
          .parse(request.query),
        tab = fulfillmentTabSchema.catch('in_queue').parse(query.tab ?? 'in_queue');
      // The content view enqueues O1; Load More (offset > 0) does not (`order/views.py:5316`).
      if (query.offset === 0) await enqueueAutoReject(jobs, await service.checkInStore(user), log);
      return service.progressOrders(user, tab, query.offset);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/fulfillment/summary',
    { config: trace('express-summary', 'read') },
    async (request) => {
      const user = authenticated(request),
        params = scope.parse(request.params);
      z.object({}).strict().parse(request.query);
      requireStore(user, params.storeId);
      return service.summary(params.storeId);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/fulfillment/expiry-alerts',
    { config: trace('express-expiry-alert', 'list') },
    async (request) => {
      z.object({}).strict().parse(request.query);
      const user = authenticated(request),
        params = scope.parse(request.params);
      await requireCurrentCheckIn(user.id, params.storeId, 'expiry reminders');
      const alerts = await service.expiryAlerts(user, params.storeId);
      return {
        ...alerts,
        pollIntervalMs: credentials.HL_EXPIRY_POLL_INTERVAL_MS,
        businessTimeZone: config.BUSINESS_TIMEZONE,
      };
    },
  );
  app.get(
    '/api/v1/fulfillment/rejection-reasons',
    { config: trace('rejection-reason', 'list') },
    async (request) => {
      authenticated(request);
      z.object({}).strict().parse(request.query);
      return service.rejectionReasons();
    },
  );

  // ── Express actions ──
  const empty = z.object({}).strict();
  app.post(
    '/api/v1/stores/:storeId/fulfillment/orders/:orderId/acceptance',
    { config: trace('express-order', 'acceptance') },
    async (request) => {
      const user = assertOperator(request),
        params = orderScope.parse(request.params);
      empty.parse(request.body ?? {});
      return service.accept(user, params.storeId, params.orderId);
    },
  );
  app.post(
    '/api/v1/stores/:storeId/fulfillment/orders/:orderId/rejection',
    { config: trace('express-order', 'rejection') },
    async (request) => {
      const user = assertOperator(request),
        params = orderScope.parse(request.params),
        body = z
          .object({ rejectionReasonId: identifier.optional() })
          .strict()
          .parse(request.body ?? {});
      if (!body.rejectionReasonId)
        throw new AppError(400, 'REJECTION_REASON_REQUIRED', 'Rejection reason is required');
      return service.reject(user, params.storeId, params.orderId, body.rejectionReasonId);
    },
  );
  for (const [path, action] of [
    ['packing', 'pack'],
    ['shipment', 'ship'],
    ['rto-receipt', 'rto'],
  ] as const)
    app.post(
      `/api/v1/stores/:storeId/fulfillment/orders/:orderId/${path}`,
      { config: trace('express-order', path) },
      async (request) => {
        const user = assertOperator(request),
          params = orderScope.parse(request.params);
        empty.parse(request.body ?? {});
        return service[action](user, params.storeId, params.orderId);
      },
    );
  app.put(
    '/api/v1/stores/:storeId/fulfillment/orders/:orderId/lines/:lineId/packing',
    { config: trace('express-line', 'pack') },
    async (request) => {
      const user = assertOperator(request),
        params = orderScope.extend({ lineId: identifier }).parse(request.params);
      empty.parse(request.body ?? {});
      return service.packLine(user, params.storeId, params.orderId, params.lineId);
    },
  );
  app.patch(
    '/api/v1/stores/:storeId/fulfillment/orders/:orderId',
    { config: trace('express-order', 'admin-edit') },
    async (request) => {
      const user = assertOperator(request),
        params = orderScope.parse(request.params);
      requireRole(user, [1]);
      const dateTime = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Invalid expiry format')
        .refine((value) => {
          try {
            Temporal.PlainDateTime.from(value);
            return true;
          } catch {
            return false;
          }
        }, 'Invalid expiry format');
      const body = z
        .object({
          status: expressStatusSchema.optional(),
          pendingExpiresAt: dateTime.optional(),
          acceptedExpiresAt: dateTime.optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0, 'Nothing to update')
        .parse(request.body);
      return service.edit(user, params.storeId, params.orderId, body);
    },
  );

  // ── All-stores monitoring dashboard (`order/hl_all_stores.py`) ──
  app.get(
    '/api/v1/fulfillment/store-monitoring/stores',
    { config: trace('monitoring-store', 'list') },
    async (request) => {
      authenticated(request);
      z.object({}).strict().parse(request.query);
      return monitoring.stores();
    },
  );
  app.get(
    '/api/v1/fulfillment/store-monitoring/defaults',
    { config: trace('store-monitoring-default', 'read') },
    async (request) => {
      z.object({}).strict().parse(request.query);
      return monitoring.defaults(authenticated(request));
    },
  );
  app.get(
    '/api/v1/fulfillment/store-monitoring',
    { config: trace('store-monitoring', 'list') },
    async (request) => {
      authenticated(request);
      // Legacy `HLGlobalFilters.from_request` sanitises instead of rejecting.
      const date = z
        .string()
        .max(10)
        .optional()
        .transform((value) => {
          if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
          try {
            return Temporal.PlainDate.from(value).toString();
          } catch {
            return undefined;
          }
        });
      const ids = z
        .string()
        .max(20000)
        .optional()
        .transform((value) =>
          (value ?? '')
            .split(',')
            .map((part) => part.trim())
            .filter((part) => /^\d{1,19}$/.test(part) && BigInt(part) > 0n),
        );
      const raw = z
        .object({
          from: date,
          to: date,
          storeIds: ids,
          orderIds: ids,
          tab: z.string().max(32).optional(),
          subStatuses: z.string().max(500).optional(),
          page: z.string().max(12).optional(),
          pageSize: z.string().max(4).optional(),
        })
        .strict()
        .parse(request.query);
      const tab = monitorTabSchema.catch('in_queue').parse(raw.tab ?? 'in_queue'),
        allowed: readonly string[] = monitorTabs[tab],
        page = Math.max(1, Number.parseInt(raw.page ?? '1', 10) || 1),
        size = Number.parseInt(raw.pageSize ?? '25', 10);
      return monitoring.read({
        from: raw.from,
        to: raw.to,
        storeIds: raw.storeIds.filter((id) => BigInt(id) <= 2147483647n),
        orderIds: raw.orderIds,
        tab,
        subStatuses: (raw.subStatuses ?? '')
          .split(',')
          .filter((status) => allowed.includes(status))
          .map((status) => expressStatusSchema.parse(status)),
        page,
        pageSize: ([10, 25, 50, 100, 500] as const).find((value) => value === size) ?? 25,
      });
    },
  );

  // ── Legacy service webhooks (external senders keep their legacy contracts) ──
  await app.register(async (scoped) => {
    // Legacy reads the raw body itself (`json.loads(request.body)` / `request.POST`).
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) =>
      done(null, body),
    );
    const notifyBody = z
      .object({
        order_id: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,18}$/)]),
        store_ids: z
          .array(z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,9}$/)]))
          .min(1)
          .max(500),
      })
      .loose();
    /** `AjaxExpressOrderNotifyView` (`order/views.py:5252-5281`). */
    async function notify(request: FastifyRequest, reply: FastifyReply) {
      try {
        verifyWebhookCredentials(credentials, request.headers);
      } catch {
        return reply.code(401).send({ status: '401', message: 'Authentication Failed' });
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(typeof request.body === 'string' ? request.body : '');
      } catch {
        return reply.code(400).send({ status: '400', message: 'Invalid JSON' });
      }
      const body = notifyBody.safeParse(parsedJson);
      if (!body.success)
        return reply
          .code(400)
          .send({ status: '400', message: 'order_id and store_ids are required' });
      for (const storeId of body.data.store_ids)
        await enqueueAdvanceOrderNotification(
          jobs,
          {
            title: 'Hyperlocal Order',
            order_id: String(body.data.order_id),
            store_id: String(storeId),
            is_slack: true,
            is_new_order: true,
            send_to_common: false,
          },
          { queue: 'order' },
        );
      return reply.code(200).send({ status: '200', message: 'Notification queued' });
    }
    /** `ExpressOrderMarkShippedApiView` (`order/views.py:5141-5166`). */
    async function courierShip(request: FastifyRequest, reply: FastifyReply) {
      if (!secretMatches(credentials.EXPRESS_ORDER_API_KEY, request.headers.apikey))
        return reply.code(401).send({ status: 'failed', message: 'wrong api key' });
      const orderId = formField(request.body, request, 'order_id'),
        awb = formField(request.body, request, 'awb');
      if (!orderId || !awb || !/^[1-9]\d{0,18}$/.test(orderId) || awb.length > 50)
        return reply.send({ message: 'Invalid request', status: '400' });
      try {
        const result = await service.shipFromCourier(orderId, awb);
        if (!result)
          return reply.send({ message: 'Could not resolve store for order/awb', status: '400' });
        return reply.send({
          message: 'Success',
          status: '200',
          updated_count: result.updatedCount,
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'FULFILLMENT_STATE_CONFLICT')
          return reply.send({ message: error.message, status: '400' });
        throw error;
      }
    }
    for (const prefix of ['/orders', '/api/v1/orders']) {
      scoped.post(
        `${prefix}/ajax-express-order-notify/`,
        {
          config: { ...trace('express-order-webhook', 'receive'), authentication: 'service' },
        },
        notify,
      );
      scoped.post(
        `${prefix}/ship-express-order/`,
        {
          config: { ...trace('express-shipment-webhook', 'receive'), authentication: 'service' },
        },
        courierShip,
      );
    }
  });

  app.get(
    '/api/v1/stores/:storeId/notifications',
    { config: { trace: { module: 'notifications', resource: 'notification', action: 'list' } } },
    async (request) => {
      const user = authenticated(request),
        params = scope.parse(request.params),
        query = z
          .object({
            after: cursor.default('0'),
            limit: z.coerce.number().int().min(1).max(100).default(30),
          })
          .strict()
          .parse(request.query);
      await requireCurrentCheckIn(user.id, params.storeId, 'notifications');
      const notices = await service.notifications(user, params.storeId, query.after, query.limit);
      await requireCurrentCheckIn(user.id, params.storeId, 'notifications');
      return notices;
    },
  );
  app.put(
    '/api/v1/stores/:storeId/notifications/:notificationId/read-receipt',
    { config: { trace: { module: 'notifications', resource: 'read-receipt', action: 'create' } } },
    async (request) => {
      const user = assertOperator(request),
        params = scope.extend({ notificationId: identifier }).parse(request.params);
      await requireCurrentCheckIn(user.id, params.storeId, 'notifications');
      const result = await service.markNotificationRead(
        user,
        params.storeId,
        params.notificationId,
      );
      // Read-state propagation is best effort; the authoritative DB result is already committed.
      await bus
        .publish({
          event: 'notification.read',
          notificationId: params.notificationId,
          storeId: params.storeId,
          userIds: [user.id],
          isNewOrder: false,
        })
        .catch(() => {});
      return result;
    },
  );
  // Capture the actual transport before the plugin routes Node's upgrade.
  // IncomingMessage.socket is not reliable for synthetic/in-flight upgrades.
  const upgradeTransports = new WeakMap<IncomingMessage, Duplex>();
  const streams = new WeakMap<FastifyRequest, ReturnType<typeof notificationStream>>();
  const activeStreams = new Set<ReturnType<typeof notificationStream>>();
  const captureUpgrade = (request: IncomingMessage, transport: Duplex) => {
    upgradeTransports.set(request, transport);
  };
  app.server.prependListener('upgrade', captureUpgrade);
  app.addHook('preClose', async () => {
    app.server.removeListener('upgrade', captureUpgrade);
    for (const stream of activeStreams) stream.stop();
  });
  if (!app.hasDecorator('websocketServer'))
    await app.register(websocket, { options: { maxPayload: 2048 } });
  app.get(
    '/api/v1/stores/:storeId/notifications/stream',
    {
      websocket: true,
      config: {
        trace: { module: 'notifications', resource: 'notification-stream', action: 'subscribe' },
      },
      onError: async (request) => {
        streams.get(request)?.stop();
      },
      onResponse: async (request) => {
        streams.get(request)?.stop();
      },
      preHandler: async (request) => {
        const user = authenticated(request),
          params = scope.parse(request.params);
        requireStore(user, params.storeId);
        if (request.headers.origin !== new URL(config.WEB_ORIGIN).origin)
          throw new AppError(403, 'ORIGIN_DENIED', 'Request origin is not allowed.');
        await requireCurrentCheckIn(user.id, params.storeId, 'notifications');
        // A normal GET is the plugin's 404 path and must never acquire a broker resource.
        if (!request.ws) return;
        const transport = upgradeTransports.get(request.raw);
        if (!transport)
          throw new AppError(
            503,
            'NOTIFICATIONS_UNAVAILABLE',
            'Live notifications are temporarily unavailable.',
          );
        const sessionValid = () =>
          request.authSessionValid
            ? request.authSessionValid()
            : Promise.resolve(
                Boolean(
                  request.principal &&
                  (!request.sessionExpiresAt || request.sessionExpiresAt > Date.now()),
                ),
              );
        const id = randomUUID();
        const stream = notificationStream({
          transport,
          subscribe: (receive) => bus.subscribe(params.storeId, user.id, id, receive),
          authorize: async () => {
            if (!(await sessionValid()))
              throw new AppError(401, 'SESSION_EXPIRED', 'Sign in to receive notifications.');
            await requireCurrentCheckIn(user.id, params.storeId, 'notifications');
          },
          valid: async () =>
            (await sessionValid()) && (await checkins.checkedInStore(user.id)) === params.storeId,
          expiresAt: request.sessionExpiresAt || Date.now() + 900000,
          onClosed: () => {
            activeStreams.delete(stream);
            streams.delete(request);
          },
        });
        streams.set(request, stream);
        activeStreams.add(stream);
        await stream.prepare();
      },
    },
    (socket, request) => {
      const stream = streams.get(request);
      if (!stream) {
        socket.close(1013, 'Notifications unavailable');
        return;
      }
      stream.attach(socket);
    },
  );

  return { service, bus, monitoring, effects };
}
