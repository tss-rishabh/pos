import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { authenticated } from '../../auth/routes.js';
import { commandInput } from './domain.js';
import { wholeOrderStatusService, type WholeOrderStatusService } from './service.js';
import { readWholeOrderStatusOptions, type WholeOrderStatusOptions } from './options.js';
import { registerStatusWorkerLoop } from './background.js';
export { wholeOrderStatusService, readWholeOrderStatusOptions };
export async function registerWholeOrderStatus(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: WholeOrderStatusOptions = readWholeOrderStatusOptions(),
  dependencies: Parameters<typeof wholeOrderStatusService>[3] & {
    service?: WholeOrderStatusService;
  } = {},
) {
  const service =
      dependencies.service ?? wholeOrderStatusService(config, db, options, dependencies),
    scope = z.object({ storeId: identifier, orderId: identifier }).strict(),
    empty = z.object({}).strict();
  const trace = (resource: string, action: string) => ({
    config: { trace: { module: 'whole-order-status', resource, action } },
  });
  async function checked<T>(request: FastifyRequest, read: () => Promise<T>) {
    authenticated(request);
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'SESSION_EXPIRED', 'Sign in again to continue.');
    const result = await read();
    if (!request.authSessionValid || !(await request.authSessionValid()))
      throw new AppError(401, 'SESSION_EXPIRED', 'Sign in again to continue.');
    return result;
  }
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/fulfillment-status',
    trace('whole-order-status', 'read'),
    async (request) => {
      const { storeId, orderId } = scope.parse(request.params);
      empty.parse(request.query);
      return checked(request, () => service.status(authenticated(request), storeId, orderId));
    },
  );
  app.post(
    '/api/v1/stores/:storeId/orders/:orderId/status-requests',
    trace('whole-order-status-command', 'create'),
    async (request, reply) => {
      const { storeId, orderId } = scope.parse(request.params),
        body = commandInput.parse(request.body);
      empty.parse(request.query);
      const result = await checked(request, () =>
        service.submit(authenticated(request), storeId, orderId, body, request.id),
      );
      return reply.code(202).send(result);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/status-requests/:operationId',
    trace('whole-order-status-command', 'read'),
    async (request) => {
      const { storeId, orderId, operationId } = scope
        .extend({ operationId: z.uuid() })
        .parse(request.params);
      empty.parse(request.query);
      return checked(request, () =>
        service.read(authenticated(request), storeId, orderId, operationId),
      );
    },
  );
  app.post(
    '/api/v1/stores/:storeId/orders/:orderId/status-repairs',
    trace('whole-order-return-status-repair', 'create'),
    async (request, reply) => {
      const { storeId, orderId } = scope.parse(request.params),
        body = z
          .object({ operationId: z.uuid(), returnOperationId: z.uuid() })
          .strict()
          .parse(request.body);
      empty.parse(request.query);
      const result = await checked(request, () =>
        service.repair(authenticated(request), storeId, orderId, body, request.id),
      );
      return reply.code(202).send(result);
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/status-repair-obligations',
    trace('return-repair-obligation', 'list'),
    async (request) => {
      const { storeId, orderId } = scope.parse(request.params);
      empty.parse(request.query);
      return checked(request, () => service.repairs.list(authenticated(request), storeId, orderId));
    },
  );
  app.get(
    '/api/v1/stores/:storeId/orders/:orderId/status-repair-obligations/:returnId',
    trace('return-repair-obligation', 'read'),
    async (request) => {
      const { storeId, orderId, returnId } = scope
        .extend({ returnId: z.uuid() })
        .parse(request.params);
      empty.parse(request.query);
      return checked(request, () =>
        service.repairs.read(authenticated(request), storeId, orderId, returnId),
      );
    },
  );
  app.post(
    '/api/v1/stores/:storeId/orders/:orderId/status-repair-obligations/:returnId/recoveries',
    trace('return-repair-obligation', 'recover'),
    async (request, reply) => {
      const { storeId, orderId, returnId } = scope
          .extend({ returnId: z.uuid() })
          .parse(request.params),
        body = z
          .object({ operationId: z.uuid(), expectedVersion: z.number().int().positive() })
          .strict()
          .parse(request.body);
      empty.parse(request.query);
      return reply
        .code(202)
        .send(
          await checked(request, () =>
            service.repairs.recover(authenticated(request), storeId, orderId, returnId, body),
          ),
        );
    },
  );
  if (options.WHOLE_ORDER_STATUS_WORKER_ENABLED && !config.DEMO_MODE)
    registerStatusWorkerLoop(
      app,
      'whole-order-status-dispatch',
      async () => {
        await service.repository.expireClaims(options.WHOLE_ORDER_STATUS_CLAIM_TIMEOUT_MS);
        const repair = await service.repairs.runOnce();
        if (repair)
          app.log.info(
            { module: 'whole-order-status', resource: 'return-repair-obligation', ...repair },
            'Rejected-return repair obligation result.',
          );
        const event = await service.worker.runOnce();
        if (event)
          app.log.info(
            { module: 'whole-order-status', resource: 'whole-order-status-dispatch', ...event },
            'Whole-order status dispatch result.',
          );
        return event !== null || repair !== null;
      },
      service.configured,
    );
  return service;
}
