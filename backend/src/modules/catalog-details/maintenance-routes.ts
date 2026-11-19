import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import {
  noBody,
  noQuery,
  operatorHeaders,
  routeSchema,
  transportHeaders,
} from '../../domain/route-validation.js';
import { inventoryPullInput } from './maintenance-domain.js';
import type { catalogMaintenanceService } from './maintenance-service.js';

const pullBody = z.object({ input: inventoryPullInput }).strict();
const productParams = z.object({ productId: identifier }).strict();
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
    {
      ...trace('catalog-maintenance', 'capabilities'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    (request) => {
      authenticated(request);
      empty(request.query);
      return service.capabilities();
    },
  );
  app.get(
    '/api/v1/catalog/inventory-pulls/sample',
    {
      ...trace('inventory-pull', 'sample'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
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
  app.post(
    '/api/v1/catalog/inventory-pulls',
    {
      ...trace('inventory-pull', 'create'),
      ...routeSchema({ querystring: noQuery, body: pullBody, headers: operatorHeaders }),
    },
    (request) => {
      empty(request.query);
      const body = pullBody.parse(request.body);
      return service.inventoryPull(authenticated(request), body.input, request.id);
    },
  );
  app.post(
    '/api/v1/catalog/products/:productId/troubleshooting',
    {
      ...trace('product-troubleshoot', 'apply'),
      ...routeSchema({
        params: productParams,
        querystring: noQuery,
        body: noBody,
        headers: operatorHeaders,
      }),
    },
    (request) => {
      const user = authenticated(request),
        params = productParams.parse(request.params);
      empty(request.query);
      empty(request.body);
      return service.troubleshoot(user, params.productId, request.id);
    },
  );
}
