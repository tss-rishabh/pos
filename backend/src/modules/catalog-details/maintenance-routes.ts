import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { inventoryPullInput } from './maintenance-domain.js';
import type { catalogMaintenanceService } from './maintenance-service.js';

/** Legacy `inventory-sync/` (core/urls.py:79) and `ajax-troubleshoot-product/` (:154). */
export async function registerCatalogMaintenanceRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof catalogMaintenanceService>,
) {
  const trace = (resource: string, action: string) => ({
      config: { trace: { module: 'catalog-details', resource, action } },
    }),
    empty = (value: unknown) =>
      z
        .object({})
        .strict()
        .parse(value ?? {});
  app.get(
    '/api/v1/catalog/maintenance/capabilities',
    trace('catalog-maintenance', 'capabilities'),
    (request) => {
      authenticated(request);
      empty(request.query);
      return service.capabilities();
    },
  );
  app.get(
    '/api/v1/catalog/inventory-pulls/sample',
    trace('inventory-pull', 'sample'),
    (request, reply) => {
      authenticated(request);
      empty(request.query);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="inventory-pull-sample.csv"')
        .header('Cache-Control', 'no-store')
        .send('sku\n');
    },
  );
  app.post('/api/v1/catalog/inventory-pulls', trace('inventory-pull', 'create'), (request) => {
    empty(request.query);
    const body = z.object({ input: inventoryPullInput }).strict().parse(request.body);
    return service.inventoryPull(authenticated(request), body.input, request.id);
  });
  app.post(
    '/api/v1/catalog/products/:productId/troubleshooting',
    trace('product-troubleshoot', 'apply'),
    (request) => {
      const user = authenticated(request),
        params = z.object({ productId: identifier }).strict().parse(request.params);
      empty(request.query);
      empty(request.body);
      return service.troubleshoot(user, params.productId, request.id);
    },
  );
}
