import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  configuredStockProjection,
  configuredSystemStockProjection,
} from '../../../db/stock-projection/options.js';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import { AppError } from '../../../domain/errors.js';
import { createProductSyncAdapter } from '../../administration/product-sync.js';
import { readAdministrationWorkerOptions } from '../../administration/worker-options.js';
import { checkoutEnvironment } from '../../checkout/gateway.js';
import { notificationBus } from '../../fulfillment/notification-bus.js';
import { notificationDelivery } from '../../fulfillment/notifications.js';
import { secretMatches } from '../../fulfillment/options.js';
import { commandId, lifecycleInput } from './contracts.js';
import { eventId } from './domain.js';
import { readLegacyLifecycleOptions } from './options.js';
import { createLegacyProvider } from './provider.js';
import { lifecycleRuntime, type LifecycleDependencies } from './runtime.js';
import { localDeliveryService } from './service.js';
import { localDeliveryWorker } from './worker.js';

export function registerLegacyLifecycle(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  supplied: Partial<LifecycleDependencies> & { environment?: NodeJS.ProcessEnv } = {},
) {
  const environment = supplied.environment || process.env,
    options = readLegacyLifecycleOptions(environment),
    provider = supplied.provider || createLegacyProvider(config, options),
    runtime = lifecycleRuntime(config, db, options, {
      ...supplied,
      provider,
      stockProcedure: supplied.stockProcedure || configuredStockProjection(config, environment),
      systemStockProcedure:
        supplied.systemStockProcedure || configuredSystemStockProjection(config, environment),
      synchronizationAvailable:
        supplied.synchronizationAvailable ??
        !!createProductSyncAdapter(config, readAdministrationWorkerOptions(environment)),
    }),
    service = localDeliveryService(runtime),
    keys = checkoutEnvironment(environment),
    worker = localDeliveryWorker(runtime, service, keys);
  const scope = z.object({ storeId: identifier, orderId: identifier }).strict(),
    operation = z.object({ commandId }).strict(),
    base = '/api/v1/stores/:storeId/local-deliveries/orders/:orderId',
    trace = (resource: string, action: string) => ({
      module: 'legacy-fulfillment',
      resource,
      action,
    });
  function actor(request: FastifyRequest) {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Sign in before continuing.',
      );
    z.object({}).strict().parse(request.query);
    return user;
  }
  app.get(
    base + '/capabilities',
    { config: { trace: trace('delivery-workflow', 'read') } },
    async (request, reply) => {
      const user = actor(request),
        params = scope.parse(request.params);
      reply.header('Cache-Control', 'private, no-store');
      return service.capabilities(user, params.storeId, params.orderId);
    },
  );
  app.get(
    base + '/commands',
    { config: { trace: trace('delivery-command-history', 'read') } },
    async (request, reply) => {
      const user = actor(request),
        params = scope.parse(request.params);
      reply.header('Cache-Control', 'private, no-store');
      return { data: await service.recent(user, params.storeId, params.orderId) };
    },
  );
  for (const [path, action, resource] of [
    ['courier-requests', 'create', 'courier-request'],
    ['transfers', 'pass', 'delivery-transfer'],
    ['online-conversions', 'convert', 'online-conversion'],
    ['cancellations', 'cancel', 'delivery-cancellation'],
  ] as const)
    app.post(
      base + '/' + path,
      { config: { trace: trace(resource, 'create') } },
      async (request, reply) => {
        const user = actor(request),
          params = scope.parse(request.params),
          input = lifecycleInput.parse(request.body);
        reply.header('Cache-Control', 'private, no-store');
        return service.submit(user, params.storeId, params.orderId, action, input, request.id);
      },
    );
  app.get(
    '/api/v1/local-delivery-commands/:commandId',
    { config: { trace: trace('delivery-command', 'read') } },
    async (request, reply) => {
      const user = actor(request),
        params = operation.parse(request.params);
      reply.header('Cache-Control', 'private, no-store');
      return service.view(user, params.commandId);
    },
  );
  app.post(
    '/api/v1/local-delivery-commands/:commandId/reconciliations',
    { config: { trace: trace('delivery-reconciliation', 'create') } },
    async (request, reply) => {
      const user = actor(request),
        params = operation.parse(request.params);
      reply.header('Cache-Control', 'private, no-store');
      return service.reconcile(user, params.commandId, request.body, request.id);
    },
  );
  const sourceFlag = z
      .union([
        z.boolean(),
        z.enum(['0', '1', 'true', 'false']).transform((value) => value === '1' || value === 'true'),
      ])
      .default(false),
    sourceId = z.union([identifier, z.number().int().positive().safe().transform(String)]),
    arrival = z
      .object({
        commandId: commandId.optional(),
        order_id: sourceId,
        location_id: sourceId,
        is_notify: sourceFlag,
      })
      .strict(),
    cancel = z
      .object({
        commandId: commandId.optional(),
        order_id: sourceId,
        store_id: sourceId,
        platform: z.enum(['rto', 'cancelled']),
        is_notify: sourceFlag,
        title: z.string().max(200).optional(),
      })
      .strict();
  app.register(async (integration) => {
    integration.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_request, body, done) => {
        try {
          if (typeof body !== 'string') throw new Error('Invalid service body');
          const params = new URLSearchParams(body),
            values: Record<string, string> = {};
          for (const [key, value] of params) {
            if (key in values || Object.keys(values).length >= 8)
              throw new Error('Invalid service body');
            values[key] = value;
          }
          done(null, values);
        } catch {
          done(new AppError(400, 'INVALID_SERVICE_BODY', 'Invalid delivery event body.'));
        }
      },
    );
    const credentials =
      (observer = false) =>
      async (request: FastifyRequest) => {
        const id = secretMatches(
            observer ? options.TSS_OBERVER_APP_ID : options.APP_ID,
            request.headers.appid,
          ),
          key = secretMatches(
            observer ? options.TSS_OBERVER_APP_KEY : options.APP_KEY,
            request.headers.appkey,
          );
        if (!id || !key)
          throw new AppError(401, 'SERVICE_AUTHENTICATION_REQUIRED', 'Authentication Failed');
        z.object({}).strict().parse(request.query);
      };
    integration.post(
      '/api/v1/integrations/local-deliveries/arrivals',
      {
        config: { authentication: 'service', trace: trace('delivery-arrival', 'receive') },
        preValidation: credentials(),
      },
      async (request, reply) => {
        const input = arrival.parse(request.body);
        reply.header('Cache-Control', 'private, no-store');
        return service.arrive(
          input.location_id,
          input.order_id,
          {
            commandId:
              input.commandId ||
              eventId('local-delivery-arrival', input.order_id, input.location_id),
            notify: input.is_notify,
          },
          request.id,
        );
      },
    );
    integration.post(
      '/api/v1/integrations/local-deliveries/cancellations',
      {
        config: {
          authentication: 'service',
          trace: trace('delivery-observer-cancellation', 'receive'),
        },
        preValidation: credentials(true),
      },
      async (request, reply) => {
        const input = cancel.parse(request.body);
        reply.header('Cache-Control', 'private, no-store');
        return service.observeCancellation(
          input.store_id,
          input.order_id,
          {
            commandId:
              input.commandId ||
              eventId(
                'local-delivery-observer-cancellation',
                input.order_id,
                input.store_id,
                input.platform,
              ),
            notify: input.is_notify,
            reason: input.platform === 'rto' ? 'RTO-intransit' : 'Delivery cancelled',
            notificationTitle: input.title || 'Hyperlocal Order',
          },
          request.id,
        );
      },
    );
  });
  if (options.LEGACY_DELIVERY_WORKER_ENABLED && !config.DEMO_MODE) {
    const abort = new AbortController(),
      bus = notificationBus(config),
      publications = notificationDelivery(config, db, bus);
    let timer: ReturnType<typeof setInterval> | undefined,
      running: Promise<void> | null = null;
    const tick = () => {
      if (running || abort.signal.aborted) return;
      running = (async () => {
        const runId = randomUUID();
        try {
          await worker.expireClaims();
          await worker.applyPending();
          for (
            let index = 0;
            index < options.LEGACY_DELIVERY_WORKER_BATCH_SIZE && !abort.signal.aborted;
            index++
          ) {
            const job = await worker.runNextJob(),
              call = await worker.dispatchNext(abort.signal);
            for (const value of [job, call])
              if (value)
                app.log.info(
                  {
                    module: 'legacy-fulfillment',
                    resource: 'local-delivery-worker',
                    eventId: 'legacy-fulfillment.local-delivery-worker.progress',
                    eventInstanceId: 'callId' in value ? value.callId : value.jobId,
                    requestId: value.requestId,
                    userId: value.userId,
                    status: value.status,
                  },
                  'Local delivery worker advanced',
                );
            if (!job && !call) break;
          }
          await publications.publishPending(options.LEGACY_DELIVERY_WORKER_BATCH_SIZE);
        } catch {
          if (!abort.signal.aborted)
            app.log.warn(
              {
                module: 'legacy-fulfillment',
                resource: 'local-delivery-worker',
                eventId: 'legacy-fulfillment.local-delivery-worker.failed',
                eventInstanceId: runId,
                requestId: runId,
                userId: 'service',
                errorCode: 'LOCAL_DELIVERY_WORKER_FAILED',
              },
              'Local delivery worker needs attention',
            );
        }
      })().finally(() => {
        running = null;
      });
    };
    app.addHook('onReady', async () => {
      timer = setInterval(tick, options.LEGACY_DELIVERY_WORKER_INTERVAL_MS);
      timer.unref();
      tick();
    });
    app.addHook('onClose', async () => {
      abort.abort();
      if (timer) clearInterval(timer);
      await running;
      await bus.close();
    });
  }
  return service;
}
