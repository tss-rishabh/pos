import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { assertMaintenancePrincipal } from './maintenance-authority.js';
import { inventoryPullInput } from './maintenance-domain.js';
import type { catalogMaintenanceService } from './maintenance-service.js';
export async function registerCatalogMaintenanceRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof catalogMaintenanceService>,
) {
  const trace = (resource: string, action: string) => ({
      config: { trace: { module: 'catalog-details', resource, action } },
    }),
    product = z.object({ productId: identifier }),
    command = z.object({ commandId: z.uuid() });
  app.get(
    '/api/v1/catalog/maintenance/capabilities',
    trace('catalog-maintenance', 'capabilities'),
    (request) => service.capabilities(authenticated(request)),
  );
  app.get(
    '/api/v1/catalog/inventory-pulls/sample',
    trace('inventory-pull', 'sample'),
    (request, reply) => {
      assertMaintenancePrincipal(authenticated(request));
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="inventory-pull-sample.csv"')
        .header('Cache-Control', 'no-store')
        .send('sku\n');
    },
  );
  app.post(
    '/api/v1/catalog/inventory-pulls',
    trace('inventory-pull', 'enqueue'),
    async (request, reply) => {
      const body = z
        .object({ commandId: z.uuid(), input: inventoryPullInput })
        .strict()
        .parse(request.body);
      return reply
        .code(202)
        .send(
          await service.enqueuePull(authenticated(request), body.commandId, body.input, request.id),
        );
    },
  );
  app.post(
    '/api/v1/catalog/products/:productId/troubleshooting/preview',
    trace('product-troubleshoot', 'preview'),
    (request) => {
      const params = product.parse(request.params);
      z.object({})
        .strict()
        .parse(request.body === undefined ? {} : request.body);
      return service.preview(authenticated(request), params.productId);
    },
  );
  app.post(
    '/api/v1/catalog/products/:productId/troubleshooting',
    trace('product-troubleshoot', 'apply'),
    async (request, reply) => {
      const params = product.parse(request.params),
        body = z
          .object({ commandId: z.uuid(), expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict()
          .parse(request.body);
      return reply
        .code(202)
        .send(
          await service.troubleshoot(
            authenticated(request),
            body.commandId,
            params.productId,
            body.expectedPlanHash,
            request.id,
          ),
        );
    },
  );
  app.get(
    '/api/v1/catalog/maintenance-commands',
    trace('catalog-maintenance-command', 'active'),
    (request) => service.active(authenticated(request)),
  );
  app.get(
    '/api/v1/catalog/maintenance-commands/:commandId',
    trace('catalog-maintenance-command', 'read'),
    (request) => service.get(authenticated(request), command.parse(request.params).commandId),
  );
  app.post(
    '/api/v1/catalog/maintenance-commands/:commandId/deliveries/:deliveryId/reconciliation',
    trace('catalog-maintenance-delivery', 'reconcile'),
    (request) => {
      const params = z.object({ commandId: z.uuid(), deliveryId: z.uuid() }).parse(request.params),
        body = z
          .object({ reconciliationId: z.uuid(), outcome: z.enum(['delivered', 'not-delivered']) })
          .strict()
          .parse(request.body);
      return service.reconcile(
        authenticated(request),
        params.commandId,
        params.deliveryId,
        body.reconciliationId,
        body.outcome,
        request.id,
      );
    },
  );
}
