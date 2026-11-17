import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../../auth/routes.js';
import { identifier } from '../../../domain/validation.js';
import { syncScope } from './domain.js';
import { ecommerceInput } from '../settings-domain.js';
import type { ecommerceInventorySynchronization } from './service.js';
export { ecommerceInventorySynchronization } from './service.js';
export { readEcommerceSynchronizationOptions } from './options.js';
export { createEcommerceFullSyncAdapter } from './http.js';
export function registerEcommerceInventorySynchronization(
  app: FastifyInstance,
  service: ReturnType<typeof ecommerceInventorySynchronization>,
) {
  const none = z.object({}).strict(),
    trace = (resource: string, action: string) => ({
      config: {
        trace: { module: 'administration', resource, action },
        rateLimit: { max: action === 'read' ? 120 : 10, timeWindow: '1 minute' },
      },
    });
  app.get(
    '/api/v1/admin/stores/:storeId/ecommerce-settings/operations/:operationId',
    trace('ecommerce-settings-operation', 'read'),
    async (request, reply) => {
      none.parse(request.query);
      const { storeId, operationId } = z
        .object({ storeId: identifier, operationId: z.uuid() })
        .strict()
        .parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.operation(authenticated(request), storeId, operationId));
    },
  );
  app.get(
    '/api/v1/admin/stores/:storeId/ecommerce-inventory-syncs/:syncId',
    trace('ecommerce-inventory-sync', 'read'),
    async (request, reply) => {
      none.parse(request.query);
      const { storeId, syncId } = syncScope.parse(request.params);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.status(authenticated(request), storeId, syncId));
    },
  );
  app.post(
    '/api/v1/admin/stores/:storeId/ecommerce-inventory-syncs/:syncId/retries',
    trace('ecommerce-inventory-sync', 'retry'),
    async (request, reply) => {
      none.parse(request.query);
      const { storeId, syncId } = syncScope.parse(request.params),
        { operationId } = z.object({ operationId: z.uuid() }).strict().parse(request.body);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.retry(authenticated(request), storeId, syncId, operationId));
    },
  );
  app.post(
    '/api/v1/admin/stores/:storeId/ecommerce-settings/cancellations',
    trace('ecommerce-settings-operation', 'cancel'),
    async (request, reply) => {
      none.parse(request.query);
      const { storeId } = z.object({ storeId: identifier }).strict().parse(request.params);
      const input = z
        .object({ operationId: z.uuid(), original: ecommerceInput })
        .strict()
        .parse(request.body);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.cancel(authenticated(request), storeId, input));
    },
  );
  app.get(
    '/api/v1/admin/stores/:storeId/ecommerce-inventory-syncs/:syncId/records',
    trace('ecommerce-inventory-sync-record', 'read'),
    async (request, reply) => {
      const { storeId, syncId } = syncScope.parse(request.params),
        { after, limit } = z
          .object({
            after: identifier.optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .strict()
          .parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.records(authenticated(request), storeId, syncId, after, limit));
    },
  );
}
