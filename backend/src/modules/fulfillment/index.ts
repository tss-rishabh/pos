import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { checkInService } from '../administration/checkins.js';
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
import { fulfillmentOutbox, type EffectDispatcher } from './outbox.js';
import { integrationDispatcher } from './integrations.js';
import { notificationDelivery } from './notifications.js';
import { fulfillmentMaintenance } from './maintenance.js';
import { fulfillmentWorker } from './worker.js';
import { fulfillmentMonitoring, monitorTabSchema } from './monitoring.js';

const scope = z.object({ storeId: identifier }),
  orderScope = scope.extend({ orderId: identifier });
const trace = (resource: string, action: string) => ({
  trace: { module: 'fulfillment', resource, action },
});
interface RegistrationOptions {
  service?: FulfillmentService;
  bus?: NotificationBus;
  credentials?: FulfillmentOptions;
  dispatcher?: EffectDispatcher;
  checkins?: Pick<ReturnType<typeof checkInService>, 'checkedInStore' | 'checkedInUsers'>;
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

export async function registerFulfillment(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: RegistrationOptions = {},
) {
  const service = options.service || fulfillmentService(config, db),
    credentials = options.credentials || readFulfillmentOptions();
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
  const outbox = fulfillmentOutbox(
    config,
    db,
    options.dispatcher || integrationDispatcher(config, db, credentials),
  );
  const checkins = options.checkins || checkInService(db, config);
  async function requireCurrentCheckIn(
    userId: string,
    storeId: string,
    purpose: 'notifications' | 'expiry reminders',
  ) {
    if ((await checkins.checkedInStore(userId)) !== storeId)
      throw new AppError(403, 'CHECK_IN_REQUIRED', `Check into this store to receive ${purpose}.`);
  }
  const notifications = notificationDelivery(config, db, bus, checkins);
  const maintenance = fulfillmentMaintenance(config, db, credentials);
  const worker = fulfillmentWorker(
    config,
    db,
    outbox,
    maintenance,
    notifications,
    credentials,
    (level, event, message) => app.log[level](event, message),
  );
  const monitoring = fulfillmentMonitoring(config, db);
  app.get(
    '/api/v1/fulfillment/store-monitoring/stores',
    { config: trace('monitoring-store', 'list') },
    async (request) => monitoring.stores(authenticated(request)),
  );
  app.get(
    '/api/v1/fulfillment/store-monitoring',
    { config: trace('store-monitoring', 'list') },
    async (request) => {
      const user = authenticated(request),
        today = Temporal.Now.instant()
          .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
          .toPlainDate()
          .toString();
      const day = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((value) => {
          try {
            return Temporal.PlainDate.from(value).year >= 1000;
          } catch {
            return false;
          }
        }, 'Use a valid calendar date.');
      const ids = z
        .string()
        .max(20000)
        .transform((value) => (value ? z.array(identifier).max(500).parse(value.split(',')) : []));
      const query = z
        .object({
          from: day.default(today),
          to: day.default(today),
          storeIds: ids.optional(),
          orderIds: ids.optional(),
          tab: monitorTabSchema.default('in_queue'),
          subStatuses: z
            .string()
            .max(500)
            .transform((value) =>
              value ? z.array(expressStatusSchema).max(8).parse(value.split(',')) : [],
            )
            .optional(),
          page: z.coerce.number().int().min(1).max(10000).default(1),
          pageSize: z.coerce
            .number()
            .pipe(
              z.union([
                z.literal(10),
                z.literal(25),
                z.literal(50),
                z.literal(100),
                z.literal(500),
              ]),
            )
            .default(25),
        })
        .strict()
        .parse(request.query);
      return monitoring.read(user, query);
    },
  );
  app.addHook('onClose', async () => {
    await worker.stop();
    await bus.close();
  });
  app.addHook('onReady', async () => {
    if (credentials.FULFILLMENT_WORKER_ENABLED && !config.DEMO_MODE) worker.start();
  });

  app.get(
    '/api/v1/stores/:storeId/fulfillment/summary',
    { config: trace('express-summary', 'read') },
    async (request) => {
      const user = authenticated(request),
        params = scope.parse(request.params);
      return service.summary(user, params.storeId);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/fulfillment/orders',
    { config: trace('express-order', 'list') },
    async (request) => {
      const user = authenticated(request),
        params = scope.parse(request.params),
        query = z
          .object({
            tab: fulfillmentTabSchema.default('in_queue'),
            offset: z.coerce.number().int().min(0).max(10000).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(20),
          })
          .strict()
          .parse(request.query);
      return service.orders(user, params.storeId, query.tab, query.offset, query.limit);
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
      await requireCurrentCheckIn(user.id, params.storeId, 'expiry reminders');
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
      return service.rejectionReasons();
    },
  );

  for (const [path, action] of [
    ['acceptance', 'ACCEPT'],
    ['rejection', 'REJECT'],
    ['packing', 'PACK'],
    ['shipment', 'SHIP'],
    ['rto-receipt', 'RTO'],
  ] as const) {
    app.post(
      `/api/v1/stores/:storeId/fulfillment/orders/:orderId/${path}`,
      { config: trace('express-order', path) },
      async (request, reply) => {
        const user = assertOperator(request),
          params = orderScope.parse(request.params),
          body = z
            .object({ commandId: z.uuid(), rejectionReasonId: identifier.optional() })
            .strict()
            .parse(request.body);
        const result = await service.execute(user, { ...params, ...body, action }, request.id);
        return reply.code(result.integrationState === 'pending' ? 202 : 200).send(result);
      },
    );
  }
  app.put(
    '/api/v1/stores/:storeId/fulfillment/orders/:orderId/lines/:lineId/packing',
    { config: trace('express-line', 'pack') },
    async (request, reply) => {
      const user = assertOperator(request),
        params = orderScope.extend({ lineId: identifier }).parse(request.params),
        body = z.object({ commandId: z.uuid() }).strict().parse(request.body);
      const result = await service.execute(
        user,
        { ...params, ...body, action: 'PACK_LINE' },
        request.id,
      );
      return reply.code(result.integrationState === 'pending' ? 202 : 200).send(result);
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
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
        .refine((value) => {
          try {
            Temporal.PlainDateTime.from(value);
            return true;
          } catch {
            return false;
          }
        }, 'Use a valid date and time.');
      const body = z
        .object({
          status: expressStatusSchema.optional(),
          pendingExpiresAt: dateTime.optional(),
          acceptedExpiresAt: dateTime.optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0, 'Provide at least one change.')
        .parse(request.body);
      return service.edit(user, params.storeId, params.orderId, body);
    },
  );
  app.get(
    '/api/v1/fulfillment/commands/:commandId',
    { config: trace('express-command', 'read') },
    async (request) => {
      const user = authenticated(request),
        params = z.object({ commandId: z.uuid() }).parse(request.params);
      return service.receipt(user, params.commandId);
    },
  );

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

  app.post(
    '/api/v1/webhooks/express-orders',
    {
      config: { ...trace('express-order-webhook', 'receive'), authentication: 'service' },
      preValidation: async (request) => verifyWebhookCredentials(credentials, request.headers),
    },
    async (request, reply) => {
      const body = z
        .object({
          orderId: identifier,
          storeIds: z.array(identifier).min(1).max(200),
          eventId: z.uuid(),
        })
        .strict()
        .parse(request.body);
      return reply.code(202).send(await notifications.receive(body, request.id));
    },
  );
  app.post(
    '/api/v1/webhooks/express-shipments',
    {
      config: { ...trace('express-shipment-webhook', 'receive'), authentication: 'service' },
      preValidation: async (request) => {
        if (!secretMatches(credentials.EXPRESS_ORDER_API_KEY, request.headers['x-api-key']))
          throw new AppError(401, 'SERVICE_AUTHENTICATION_REQUIRED', 'Authentication Failed');
      },
    },
    async (request, reply) => {
      const body = z
        .object({
          commandId: z.uuid(),
          orderId: identifier,
          awb: z.string().trim().min(1).max(255),
        })
        .strict()
        .parse(request.body);
      const receipt = await service.shipFromCourier(
        body.commandId,
        body.orderId,
        body.awb,
        request.id,
      );
      return reply.code(receipt.integrationState === 'pending' ? 202 : 200).send(receipt);
    },
  );
  return {
    service,
    bus,
    outbox,
    notifications,
    monitoring,
    maintenance,
    worker,
  };
}
