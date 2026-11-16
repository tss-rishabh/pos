import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { configuredStockProjection } from '../../db/stock-projection/options.js';
import { authenticated } from '../../auth/routes.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { createProductSyncAdapter } from '../administration/product-sync.js';
import { readAdministrationWorkerOptions } from '../administration/worker-options.js';
import { legacyRequestSchema } from './domain.js';
import { legacyFulfillmentService, type LegacyFulfillmentOptions } from './service.js';
import { registerLegacyLifecycle } from './lifecycle/index.js';
import type { LifecycleDependencies } from './lifecycle/runtime.js';

export function registerLegacyFulfillment(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: LegacyFulfillmentOptions & {
    service?: ReturnType<typeof legacyFulfillmentService>;
    lifecycle?: false | (Partial<LifecycleDependencies> & { environment?: NodeJS.ProcessEnv });
  } = {},
) {
  const service =
    options.service ||
    legacyFulfillmentService(config, db, {
      ...options,
      stockProcedure: options.stockProcedure || configuredStockProjection(config),
      synchronizationAvailable:
        options.synchronizationAvailable ??
        !!createProductSyncAdapter(config, readAdministrationWorkerOptions()),
    });
  if (options.lifecycle !== false)
    registerLegacyLifecycle(app, config, db, options.lifecycle || {});
  const base = '/api/v1/stores/:storeId/legacy-fulfillment/orders/:orderId',
    params = z.object({ storeId: identifier, orderId: identifier }).strict(),
    trace = (resource: string, action: string) => ({
      config: { trace: { module: 'legacy-fulfillment', resource, action } },
    });
  const actor = (request: FastifyRequest) => {
    const user = authenticated(request);
    if (request.headers['x-operator-id'] !== user.id)
      throw new AppError(
        409,
        'OPERATOR_CHANGED',
        'The signed-in operator changed. Sign back in before continuing.',
      );
    z.object({}).strict().parse(request.query);
    return user;
  };
  app.get(base, trace('legacy-order', 'read'), async (request, reply) => {
    const user = actor(request),
      value = params.parse(request.params);
    reply.header('Cache-Control', 'private, no-store');
    return { data: await service.status(user, value.storeId, value.orderId) };
  });
  app.put(base + '/packing', trace('legacy-packing', 'create'), async (request, reply) => {
    const user = actor(request),
      value = params.parse(request.params),
      input = legacyRequestSchema.parse(request.body);
    reply.header('Cache-Control', 'private, no-store');
    return service.execute(user, value.storeId, value.orderId, 'packing', input, request.id);
  });
  app.post(
    base + '/rto-receipts',
    trace('legacy-rto-receipt', 'create'),
    async (request, reply) => {
      const user = actor(request),
        value = params.parse(request.params),
        input = legacyRequestSchema.parse(request.body);
      reply.header('Cache-Control', 'private, no-store');
      return service.execute(user, value.storeId, value.orderId, 'rto-receipt', input, request.id);
    },
  );
  app.get(
    '/api/v1/legacy-fulfillment/commands/:commandId',
    trace('legacy-fulfillment-command', 'read'),
    async (request, reply) => {
      const user = actor(request),
        { commandId } = z
          .object({ commandId: z.uuid().transform((value) => value.toLowerCase()) })
          .strict()
          .parse(request.params);
      reply.header('Cache-Control', 'private, no-store');
      return service.receipt(user, commandId);
    },
  );
  return service;
}
