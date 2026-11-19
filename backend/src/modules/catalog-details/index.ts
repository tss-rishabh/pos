import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import {
  noQuery,
  routeSchema,
  transportHeaders,
  type RouteSchema,
} from '../../domain/route-validation.js';
import { auditKind, auditSearchInput, productSearchInput } from './contracts.js';
import { catalogDetailsService } from './service.js';
import { inventoryAuditService } from './audit.js';
import { catalogSnapshotService } from './snapshot.js';
import { inventoryMatrixService, inventoryMatrixInput } from './matrix.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import {
  catalogMaintenanceOptions,
  type CatalogMaintenanceOptions,
} from './maintenance-options.js';
import {
  createCatalogMaintenanceTransports,
  type MaintenanceTransports,
} from './maintenance-transports.js';
import { catalogMaintenanceService } from './maintenance-service.js';
import { registerCatalogMaintenanceRoutes } from './maintenance-routes.js';
const productParams = z.strictObject({ productId: identifier });
const auditParams = z.strictObject({ productId: identifier, kind: auditKind });
const storeParams = z.strictObject({ storeId: identifier });
interface CatalogRegistrationOptions {
  /** Redis state for `pos:lock:catalog:*` (src/jobs/module-runtime.ts). */
  ephemeral: EphemeralStore;
  maintenanceOptions?: CatalogMaintenanceOptions;
  maintenanceTransports?: MaintenanceTransports;
}

export async function registerCatalogDetails(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: CatalogRegistrationOptions,
) {
  const catalog = catalogDetailsService(config, db),
    audit = inventoryAuditService(config, db),
    snapshot = catalogSnapshotService(db),
    matrix = inventoryMatrixService(db);
  const trace = (
    resource: string,
    action: string,
    schema: Omit<RouteSchema, 'querystring' | 'headers'> = {},
  ) => ({
    config: { trace: { module: 'catalog-details', resource, action } },
    ...routeSchema({ ...schema, querystring: noQuery, headers: transportHeaders }),
  });
  app.get('/api/v1/catalog/stores', trace('catalog-store', 'list'), (request) =>
    catalog.metadata(authenticated(request)),
  );
  app.post(
    '/api/v1/catalog/products/search',
    trace('catalog-product', 'search', { body: productSearchInput }),
    (request) => catalog.search(authenticated(request), productSearchInput.parse(request.body)),
  );
  app.get(
    '/api/v1/catalog/products/:productId',
    trace('catalog-product', 'detail', { params: productParams }),
    (request) =>
      catalog.detail(authenticated(request), productParams.parse(request.params).productId),
  );
  app.post(
    '/api/v1/catalog/inventory/search',
    trace('catalog-inventory', 'search', { body: inventoryMatrixInput }),
    (request) => matrix.search(authenticated(request), inventoryMatrixInput.parse(request.body)),
  );
  app.post(
    '/api/v1/catalog/products/:productId/audits/:kind/search',
    trace('inventory-audit', 'search', { params: auditParams, body: auditSearchInput }),
    (request) => {
      const params = auditParams.parse(request.params);
      return audit.search(
        authenticated(request),
        params.productId,
        params.kind,
        auditSearchInput.parse(request.body),
      );
    },
  );
  app.get(
    '/api/v1/catalog/stores/:storeId/snapshot',
    trace('catalog-snapshot', 'read', { params: storeParams }),
    (request) => snapshot.read(authenticated(request), storeParams.parse(request.params).storeId),
  );
  const maintenanceOptions = options.maintenanceOptions || catalogMaintenanceOptions(),
    transports =
      options.maintenanceTransports ||
      createCatalogMaintenanceTransports(config, maintenanceOptions),
    maintenance = catalogMaintenanceService(
      db,
      transports,
      options.ephemeral,
      (level, event, message) => app.log[level](event, message),
    );
  await registerCatalogMaintenanceRoutes(app, maintenance);
  return { catalog, audit, snapshot, matrix, maintenance };
}
