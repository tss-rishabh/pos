import { readStoreDefaultOperatorOptions } from './store-default-operators.js';
import { administrationCollectionPageQuery } from './collection-page.js';
import type { FastifyInstance } from 'fastify';
import { registerAdministrationStoreDetails } from './store-detail-routes.js';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { sourceAdministrationFullName } from '../administration-history/messages.js';
import {
  assignmentInput,
  checkInInput,
  counterInput,
  operatorInput,
  operatorCreateInput,
  pageQuery,
  salespersonAssignmentInput,
  salespersonInput,
  statusInput,
  stockInput,
  storageInput,
  storageUpdateInput,
  locationCodeInput,
  deliverySlotInput,
  storeInput,
  visibilityInput,
} from './contracts.js';
import { administrationService, type AdministrationOptions } from './service.js';
import { checkInService } from './checkins.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { administrationEphemeralStore } from './ephemeral-runtime.js';
import { inventoryService } from './inventory.js';
import { supportService } from './support.js';
import { registerTerminalDirectory } from './terminal-directory.js';
import { storeImageService, type StoreImageOptions } from './store-images.js';
import { registerStoreImages } from './store-image-routes.js';
import { administrationAccessService } from './access-control.js';
import { registerAdministrationAccess } from './access-routes.js';
import { operatorAdministrationService, type OperatorAdminOptions } from './operator-admin.js';
import { registerOperatorAdministration } from './operator-admin-routes.js';
import { slackConnectionService } from './slack-connections.js';
import { registerSlackConnections } from './slack-routes.js';
import type { SlackConnectionOptions } from './slack-provider.js';
import { locationLookupService, registerLocationLookups } from './locations.js';
import { invalidateOperatorAuthentication } from '../../auth/revocation.js';
import { operatorCreator } from './operator-create.js';
import { terminalService, terminalProvider, terminalInput } from './terminals.js';
import { documentationService, type DocumentationOptions } from './documentation.js';
import { settingsService } from './settings.js';
import {
  operatorMfaService,
  mfaControlInput,
  mfaEnrollmentInput,
  mfaVerificationInput,
} from './mfa.js';
import { inventoryImportService, type InventoryImportOptions } from './imports.js';
import {
  importIdInput,
  importHistoryInput,
  importListInput,
  importRowListInput,
  stockCsv,
  stockImportInput,
  stockTemplateRows,
} from './import-domain.js';
import {
  allDeliveryAvailabilityInput,
  deliveryAvailabilityInput,
  deliverySlotUpdateInput,
  ecommerceInput,
  orderBufferInput,
  thresholdInput,
  type SettingsOptions,
} from './settings-domain.js';
import {
  documentationInput,
  documentationPageQuery,
  uploadInput,
  assetReference,
} from './media-domain.js';

const scope = z.object({ storeId: identifier }).strict();
const counterScope = scope.extend({ counterId: identifier });
const storageScope = scope.extend({ storageId: identifier });
const productScope = scope.extend({ productId: identifier });
const salespersonScope = z.object({ salespersonId: identifier }).strict();
const operatorScope = z.object({ operatorId: identifier }).strict();
const personPageQuery = administrationCollectionPageQuery.omit({ search: true });
const terminalScope = scope.extend({ provider: terminalProvider, terminalId: identifier });
const trace = (resource: string, action: string) => ({
  config: { trace: { module: 'administration', resource, action } },
});
const wire = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as unknown;

/** Register concrete administration resources. Parent owns auth, CSRF, errors and logging. */
export function registerAdministration(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: AdministrationOptions &
    InventoryImportOptions &
    DocumentationOptions &
    StoreImageOptions &
    OperatorAdminOptions &
    SlackConnectionOptions &
    SettingsOptions & { ephemeral?: EphemeralStore } = {},
) {
  const ephemeral = options.ephemeral ?? administrationEphemeralStore(config);
  registerTerminalDirectory(app, db);
  const storeDefaults =
    options.defaultStoreOperatorIds !== undefined ||
    options.defaultStoreOperatorContactEmails !== undefined
      ? {}
      : readStoreDefaultOperatorOptions();
  const service = administrationService(config, db, { ...storeDefaults, ...options }),
    checkins = checkInService(db, config, ephemeral),
    inventory = inventoryService(config, db, options),
    support = supportService(config, db);
  const createOperator = operatorCreator(config, db);
  // Sorted cursors can contain contact/text values; the application keeps them in private POST bodies.
  const emptyQuery = z.object({}).strict();
  app.post('/api/v1/admin/stores/search', trace('store', 'search'), async (request, reply) => {
    emptyQuery.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(
        wire(
          await service.stores(
            authenticated(request),
            administrationCollectionPageQuery.parse(request.body),
          ),
        ),
      );
  });
  app.post(
    '/api/v1/admin/stores/:storeId/counters/search',
    trace('counter', 'search'),
    async (request, reply) => {
      emptyQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          wire(
            await service.counters(
              authenticated(request),
              scope.parse(request.params).storeId,
              administrationCollectionPageQuery.parse(request.body),
            ),
          ),
        );
    },
  );
  app.post(
    '/api/v1/admin/stores/:storeId/storages/search',
    trace('storage', 'search'),
    async (request, reply) => {
      emptyQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          wire(
            await service.storages(
              authenticated(request),
              scope.parse(request.params).storeId,
              administrationCollectionPageQuery.parse(request.body),
            ),
          ),
        );
    },
  );

  registerAdministrationStoreDetails(app, db);
  const terminals = terminalService(config, db);
  const documentation = documentationService(config, db, options);
  app.post(
    '/api/v1/documentation/search',
    trace('documentation', 'search'),
    async (request, reply) => {
      emptyQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await documentation.list(
            authenticated(request),
            documentationPageQuery.parse(request.body),
          ),
        );
    },
  );
  const settings = settingsService(config, db, options);
  const mfa = operatorMfaService(config, db);
  const storeImages = storeImageService(config, db, options.storeImageStore);
  registerStoreImages(app, storeImages);
  const access = administrationAccessService(config, db);
  registerAdministrationAccess(app, access);
  const operatorAdministration = operatorAdministrationService(
    config,
    db,
    invalidateOperatorAuthentication,
    options,
  );
  registerOperatorAdministration(app, operatorAdministration);
  const slack = slackConnectionService(config, db, options);
  registerSlackConnections(app, config, slack);
  const locations = locationLookupService(db);
  registerLocationLookups(app, locations);
  app.get('/api/v1/admin/franchises', trace('franchise', 'list'), async (request) =>
    wire(await service.franchises(authenticated(request), pageQuery.parse(request.query))),
  );
  const enrollmentScope = operatorScope.extend({ enrollmentId: z.uuid() });
  app.get(
    '/api/v1/admin/operators/:operatorId/mfa',
    trace('operator-mfa', 'read'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await mfa.read(authenticated(request), operatorScope.parse(request.params).operatorId),
        ),
  );
  app.post(
    '/api/v1/admin/operators/:operatorId/mfa-enrollments',
    trace('operator-mfa-enrollment', 'create'),
    async (request, reply) =>
      reply
        .code(201)
        .header('Cache-Control', 'no-store')
        .send(
          await mfa.start(
            authenticated(request),
            operatorScope.parse(request.params).operatorId,
            mfaEnrollmentInput.parse(request.body),
          ),
        ),
  );
  app.post(
    '/api/v1/admin/operators/:operatorId/mfa-enrollments/:enrollmentId/verification',
    trace('operator-mfa-enrollment', 'verify'),
    async (request, reply) => {
      const params = enrollmentScope.parse(request.params);
      return reply
        .header('Cache-Control', 'no-store')
        .send(
          await mfa.confirm(
            authenticated(request),
            params.operatorId,
            params.enrollmentId,
            mfaVerificationInput.parse(request.body),
          ),
        );
    },
  );
  app.delete(
    '/api/v1/admin/operators/:operatorId/mfa-enrollments/:enrollmentId',
    trace('operator-mfa-enrollment', 'cancel'),
    async (request, reply) => {
      const params = enrollmentScope.parse(request.params);
      return reply
        .header('Cache-Control', 'no-store')
        .send(await mfa.cancel(authenticated(request), params.operatorId, params.enrollmentId));
    },
  );
  app.put(
    '/api/v1/admin/operators/:operatorId/mfa',
    trace('operator-mfa', 'update'),
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await mfa.update(
            authenticated(request),
            operatorScope.parse(request.params).operatorId,
            mfaControlInput.parse(request.body),
          ),
        ),
  );
  const imports = inventoryImportService(config, db, options);
  app.get(
    '/api/v1/admin/inventory-imports/capabilities',
    trace('inventory-import', 'capabilities'),
    async (request) => imports.capabilities(authenticated(request)),
  );
  app.get(
    '/api/v1/admin/inventory-imports/template',
    trace('inventory-import', 'download-template'),
    async (request, reply) => {
      imports.capabilities(authenticated(request));
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="ProductStock-template.csv"')
        .header('Cache-Control', 'no-store')
        .send(stockCsv(stockTemplateRows));
    },
  );
  app.post(
    '/api/v1/admin/inventory-imports/preview',
    trace('inventory-import', 'preview'),
    async (request) =>
      imports.preview(authenticated(request), stockImportInput.parse(request.body)),
  );
  app.post(
    '/api/v1/admin/inventory-imports',
    trace('inventory-import', 'create'),
    async (request, reply) =>
      reply
        .code(201)
        .send(await imports.create(authenticated(request), stockImportInput.parse(request.body))),
  );
  app.get('/api/v1/admin/inventory-imports', trace('inventory-import', 'list'), async (request) =>
    imports.list(authenticated(request), importListInput.parse(request.query)),
  );
  app.get(
    '/api/v1/admin/inventory-imports/history',
    trace('inventory-import', 'history'),
    async (request) =>
      imports.history(authenticated(request), importHistoryInput.parse(request.query)),
  );
  app.get(
    '/api/v1/admin/inventory-imports/:importId',
    trace('inventory-import', 'read'),
    async (request) =>
      imports.detail(authenticated(request), importIdInput.parse(request.params).importId),
  );
  app.get(
    '/api/v1/admin/inventory-imports/:importId/rows',
    trace('inventory-import', 'list-rows'),
    async (request) =>
      imports.rows(
        authenticated(request),
        importIdInput.parse(request.params).importId,
        importRowListInput.parse(request.query),
      ),
  );
  app.get(
    '/api/v1/admin/inventory-imports/:importId/failures.csv',
    trace('inventory-import', 'download-failures'),
    async (request, reply) => {
      const { importId } = importIdInput.parse(request.params);
      const content = await imports.failedCsv(authenticated(request), importId);
      return reply
        .type('text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="InventoryImport-${importId}-failed.csv"`,
        )
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(Readable.from(content));
    },
  );
  app.post(
    '/api/v1/admin/inventory-imports/:importId/resume',
    trace('inventory-import', 'resume'),
    async (request) => {
      z.object({}).strict().parse(request.body);
      return imports.control(
        authenticated(request),
        importIdInput.parse(request.params).importId,
        'resume',
      );
    },
  );
  app.post(
    '/api/v1/admin/inventory-imports/:importId/cancel',
    trace('inventory-import', 'cancel'),
    async (request) => {
      z.object({}).strict().parse(request.body);
      return imports.control(
        authenticated(request),
        importIdInput.parse(request.params).importId,
        'cancel',
      );
    },
  );
  app.get('/api/v1/admin/stores', trace('store', 'list'), async (request) =>
    wire(
      await service.stores(
        authenticated(request),
        administrationCollectionPageQuery.parse(request.query),
      ),
    ),
  );
  app.get('/api/v1/admin/stores/:storeId', trace('store', 'read'), async (request) =>
    wire(await service.store(authenticated(request), scope.parse(request.params).storeId)),
  );
  app.post('/api/v1/admin/stores', trace('store', 'create'), async (request, reply) => {
    const result = await service.createStore(
      authenticated(request),
      storeInput.parse(request.body),
    );
    return reply.code(201).send(result);
  });
  app.put('/api/v1/admin/stores/:storeId', trace('store', 'update'), async (request) =>
    service.updateStore(
      authenticated(request),
      scope.parse(request.params).storeId,
      storeInput.parse(request.body),
    ),
  );
  app.patch('/api/v1/admin/stores/:storeId/status', trace('store', 'set-status'), async (request) =>
    service.setStoreStatus(
      authenticated(request),
      scope.parse(request.params).storeId,
      statusInput.parse(request.body).active,
    ),
  );
  app.get('/api/v1/admin/countries', trace('country', 'list'), async (request) =>
    wire({ data: await service.countries(authenticated(request)) }),
  );
  app.get(
    '/api/v1/admin/store-location-codes',
    trace('store-location', 'list'),
    async (request) => ({ data: await service.locations(authenticated(request)) }),
  );
  app.post(
    '/api/v1/admin/store-location-codes',
    trace('store-location', 'create'),
    async (request) =>
      service.addLocationCode(authenticated(request), locationCodeInput.parse(request.body).code),
  );
  app.get('/api/v1/admin/stores/:storeId/counters', trace('counter', 'list'), async (request) =>
    wire(
      await service.counters(
        authenticated(request),
        scope.parse(request.params).storeId,
        administrationCollectionPageQuery.parse(request.query),
      ),
    ),
  );
  app.post(
    '/api/v1/admin/stores/:storeId/counters',
    trace('counter', 'create'),
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createCounter(
            authenticated(request),
            scope.parse(request.params).storeId,
            counterInput.parse(request.body).description,
          ),
        ),
  );
  app.patch(
    '/api/v1/admin/stores/:storeId/counters/:counterId/status',
    trace('counter', 'set-status'),
    async (request) => {
      const params = counterScope.parse(request.params);
      return service.setCounterStatus(
        authenticated(request),
        params.storeId,
        params.counterId,
        statusInput.parse(request.body).active,
      );
    },
  );
  app.get('/api/v1/admin/stores/:storeId/storages', trace('storage', 'list'), async (request) =>
    wire(
      await service.storages(
        authenticated(request),
        scope.parse(request.params).storeId,
        administrationCollectionPageQuery.parse(request.query),
      ),
    ),
  );
  app.post(
    '/api/v1/admin/stores/:storeId/storages',
    trace('storage', 'create'),
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createStorage(
            authenticated(request),
            scope.parse(request.params).storeId,
            storageInput.parse(request.body),
          ),
        ),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/storages/:storageId',
    trace('storage', 'read'),
    async (request) => {
      const params = storageScope.parse(request.params);
      return wire(await service.storage(authenticated(request), params.storeId, params.storageId));
    },
  );
  app.put(
    '/api/v1/admin/stores/:storeId/storages/:storageId',
    trace('storage', 'update'),
    async (request) => {
      const params = storageScope.parse(request.params);
      return service.updateStorage(
        authenticated(request),
        params.storeId,
        params.storageId,
        storageUpdateInput.parse(request.body),
      );
    },
  );
  app.patch(
    '/api/v1/admin/stores/:storeId/storages/:storageId/status',
    trace('storage', 'set-status'),
    async (request) => {
      const params = storageScope.parse(request.params);
      return service.setStorageStatus(
        authenticated(request),
        params.storeId,
        params.storageId,
        statusInput.parse(request.body).active,
      );
    },
  );
  app.get('/api/v1/admin/salespeople', trace('salesperson', 'list'), async (request, reply) =>
    reply.header('Cache-Control', 'private, no-store').send(
      wire(
        await service.salespeople(authenticated(request), {
          ...personPageQuery.parse(request.query),
          search: '',
        }),
      ),
    ),
  );
  app.post(
    '/api/v1/admin/salespeople/search',
    trace('salesperson', 'search'),
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          wire(
            await service.salespeople(
              authenticated(request),
              administrationCollectionPageQuery.parse(request.body),
            ),
          ),
        );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/salespeople',
    trace('store-salesperson', 'list'),
    async (request, reply) => {
      const { purpose, ...query } = personPageQuery
        .extend({ purpose: z.literal('checkout').optional() })
        .parse(request.query);
      if (purpose && query.active !== 'true')
        throw new AppError(
          400,
          'SALESPERSON_PICKER_ACTIVE_REQUIRED',
          'The checkout picker requires active salespeople.',
        );
      const result = await service.salespeople(
        authenticated(request),
        { ...query, search: '' },
        scope.parse(request.params).storeId,
        purpose === 'checkout',
      );
      return reply.header('Cache-Control', 'private, no-store').send(
        wire(
          purpose
            ? {
                ...result,
                data: result.data.map((row) => ({
                  id: row.id.toString(),
                  name: sourceAdministrationFullName(row.first_name, row.last_name),
                })),
              }
            : result,
        ),
      );
    },
  );
  app.post(
    '/api/v1/stores/:storeId/salespeople/search',
    trace('store-salesperson', 'search'),
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      const { purpose, ...page } = administrationCollectionPageQuery
        .extend({ purpose: z.literal('checkout').optional() })
        .parse(request.body);
      if (purpose && page.active !== 'true')
        throw new AppError(
          400,
          'SALESPERSON_PICKER_ACTIVE_REQUIRED',
          'The checkout picker requires active salespeople.',
        );
      const result = await service.salespeople(
        authenticated(request),
        page,
        scope.parse(request.params).storeId,
        purpose === 'checkout',
      );
      return reply.header('Cache-Control', 'private, no-store').send(
        wire(
          purpose
            ? {
                ...result,
                data: result.data.map((row) => ({
                  id: row.id.toString(),
                  name: sourceAdministrationFullName(row.first_name, row.last_name),
                })),
              }
            : result,
        ),
      );
    },
  );
  app.post('/api/v1/admin/salespeople', trace('salesperson', 'create'), async (request, reply) =>
    reply
      .code(201)
      .send(
        await service.createSalesperson(
          authenticated(request),
          salespersonInput.parse(request.body),
        ),
      ),
  );
  app.put(
    '/api/v1/admin/salespeople/:salespersonId',
    trace('salesperson', 'update'),
    async (request) =>
      service.updateSalesperson(
        authenticated(request),
        salespersonScope.parse(request.params).salespersonId,
        salespersonInput.parse(request.body),
      ),
  );
  app.patch(
    '/api/v1/admin/salespeople/:salespersonId/status',
    trace('salesperson', 'set-status'),
    async (request) =>
      service.setSalespersonStatus(
        authenticated(request),
        salespersonScope.parse(request.params).salespersonId,
        statusInput.parse(request.body).active,
      ),
  );
  app.put(
    '/api/v1/admin/salespeople/:salespersonId/stores',
    trace('salesperson-assignment', 'replace'),
    async (request) => {
      const body = salespersonAssignmentInput.parse(request.body);
      return service.assignSalespersonStores(
        authenticated(request),
        salespersonScope.parse(request.params).salespersonId,
        body.storeIds,
        body.activeStoreId,
      );
    },
  );
  app.get('/api/v1/admin/operators', trace('operator', 'list'), async (request, reply) =>
    reply.header('Cache-Control', 'private, no-store').send(
      wire(
        await service.operators(authenticated(request), {
          ...personPageQuery.parse(request.query),
          search: '',
        }),
      ),
    ),
  );
  app.post(
    '/api/v1/admin/operators/search',
    trace('operator', 'search'),
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          wire(
            await service.operators(
              authenticated(request),
              administrationCollectionPageQuery.parse(request.body),
            ),
          ),
        );
    },
  );
  app.post('/api/v1/admin/operators', trace('operator', 'create'), async (request, reply) =>
    reply
      .code(201)
      .send(await createOperator(authenticated(request), operatorCreateInput.parse(request.body))),
  );
  app.put('/api/v1/admin/operators/:operatorId', trace('operator', 'update'), async (request) =>
    service.updateOperator(
      authenticated(request),
      operatorScope.parse(request.params).operatorId,
      operatorInput.parse(request.body),
    ),
  );
  app.patch(
    '/api/v1/admin/operators/:operatorId/status',
    trace('operator', 'set-status'),
    async (request) =>
      service.setOperatorStatus(
        authenticated(request),
        operatorScope.parse(request.params).operatorId,
        statusInput.parse(request.body).active,
      ),
  );
  app.put(
    '/api/v1/admin/operators/:operatorId/stores',
    trace('operator-assignment', 'replace'),
    async (request) =>
      service.assignOperatorStores(
        authenticated(request),
        operatorScope.parse(request.params).operatorId,
        assignmentInput.parse(request.body).storeIds,
      ),
  );
  app.get('/api/v1/operators/me/check-in', trace('operator-checkin', 'read'), async (request) => ({
    data: await checkins.current(authenticated(request)),
  }));
  app.put('/api/v1/operators/me/check-in', trace('operator-checkin', 'set'), async (request) => {
    const body = checkInInput.parse(request.body);
    return checkins.set(authenticated(request), body.storeId, body.counterId);
  });
  app.delete(
    '/api/v1/operators/me/check-in',
    trace('operator-checkin', 'clear'),
    async (request, reply) => {
      await checkins.clear(authenticated(request));
      return reply.code(204).send();
    },
  );
  app.get(
    '/api/v1/admin/stores/:storeId/inventory',
    trace('store-inventory', 'list'),
    async (request) =>
      wire(
        await inventory.list(
          authenticated(request),
          scope.parse(request.params).storeId,
          pageQuery.parse(request.query),
        ),
      ),
  );
  app.put(
    '/api/v1/admin/stores/:storeId/inventory/:productId/stock',
    trace('store-inventory', 'set-stock'),
    async (request) => {
      const params = productScope.parse(request.params),
        body = stockInput.parse(request.body);
      return inventory.setStock(
        authenticated(request),
        params.storeId,
        params.productId,
        body.stock,
        body.expectedStock,
        request.id,
      );
    },
  );
  app.patch(
    '/api/v1/admin/stores/:storeId/inventory/:productId/visibility',
    trace('store-inventory', 'set-visibility'),
    async (request) => {
      const params = productScope.parse(request.params),
        body = visibilityInput.parse(request.body);
      return inventory.setVisibility(
        authenticated(request),
        params.storeId,
        params.productId,
        body.kind,
        body.checked,
        body.parentProductId,
        request.id,
      );
    },
  );
  app.get(
    '/api/v1/admin/stores/:storeId/inventory/:productId/logs',
    trace('inventory-history', 'list'),
    async (request) => {
      const params = productScope.parse(request.params),
        page = pageQuery.parse(request.query);
      return wire(
        await inventory.productLogs(
          authenticated(request),
          params.storeId,
          params.productId,
          page.after,
          page.limit,
        ),
      );
    },
  );
  app.get(
    '/api/v1/admin/stores/:storeId/delivery-slots',
    trace('delivery-slot', 'list'),
    async (request) =>
      wire({
        data: await settings.deliverySlots(
          authenticated(request),
          scope.parse(request.params).storeId,
        ),
      }),
  );
  app.post(
    '/api/v1/admin/stores/:storeId/delivery-slots',
    trace('delivery-slot', 'create'),
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await support.createDeliverySlot(
            authenticated(request),
            scope.parse(request.params).storeId,
            deliverySlotInput.parse(request.body),
          ),
        ),
  );
  app.put(
    '/api/v1/admin/stores/:storeId/delivery-slots/:slotId',
    trace('delivery-slot', 'update'),
    async (request) => {
      const params = scope.extend({ slotId: identifier }).parse(request.params);
      return settings.updateDeliverySlot(
        authenticated(request),
        params.storeId,
        params.slotId,
        deliverySlotUpdateInput.parse(request.body),
      );
    },
  );
  app.patch(
    '/api/v1/admin/stores/:storeId/delivery-slots/:slotId/availability',
    trace('delivery-slot', 'set-availability'),
    async (request) => {
      const params = scope.extend({ slotId: identifier }).parse(request.params);
      return settings.setDeliveryAvailability(
        authenticated(request),
        params.storeId,
        params.slotId,
        deliveryAvailabilityInput.parse(request.body),
      );
    },
  );
  app.patch(
    '/api/v1/admin/stores/:storeId/delivery-slots/availability',
    trace('delivery-slot', 'set-all-availability'),
    async (request) =>
      settings.setAllDeliveryAvailability(
        authenticated(request),
        scope.parse(request.params).storeId,
        allDeliveryAvailabilityInput.parse(request.body),
      ),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/payment-terminals',
    trace('payment-terminal', 'list'),
    async (request) =>
      wire({
        data: await support.paymentTerminals(
          authenticated(request),
          scope.parse(request.params).storeId,
        ),
      }),
  );
  app.get('/api/v1/admin/general-settings', trace('general-setting', 'read'), async (request) => ({
    data: await settings.generalSettings(authenticated(request)),
  }));
  app.put(
    '/api/v1/admin/general-settings/delivery-stock-threshold',
    trace('general-setting', 'update-stock-threshold'),
    async (request) =>
      settings.updateThreshold(authenticated(request), thresholdInput.parse(request.body)),
  );
  app.put(
    '/api/v1/admin/general-settings/order-creation-buffer',
    trace('general-setting', 'update-order-buffer'),
    async (request) =>
      settings.updateOrderBuffer(authenticated(request), orderBufferInput.parse(request.body)),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/ecommerce-settings',
    trace('ecommerce-setting', 'read'),
    async (request) =>
      settings.ecommerceSettings(authenticated(request), scope.parse(request.params).storeId),
  );
  app.put(
    '/api/v1/admin/stores/:storeId/ecommerce-settings',
    trace('ecommerce-setting', 'update'),
    async (request) =>
      settings.updateEcommerce(
        authenticated(request),
        scope.parse(request.params).storeId,
        ecommerceInput.parse(request.body),
      ),
  );
  app.get('/api/v1/documentation', trace('documentation', 'list'), async (request) =>
    wire(
      await documentation.list(authenticated(request), documentationPageQuery.parse(request.query)),
    ),
  );
  app.get(
    '/api/v1/admin/documentation/media-capabilities',
    trace('documentation-media', 'capabilities'),
    async (request) => documentation.capabilities(authenticated(request)),
  );
  app.get('/api/v1/documentation/:documentId', trace('documentation', 'read'), async (request) =>
    documentation.detail(
      authenticated(request),
      z.object({ documentId: identifier }).strict().parse(request.params).documentId,
    ),
  );
  app.post(
    '/api/v1/admin/documentation',
    trace('documentation', 'create'),
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await documentation.save(authenticated(request), documentationInput.parse(request.body)),
        ),
  );
  app.put(
    '/api/v1/admin/documentation/:documentId',
    trace('documentation', 'update'),
    async (request) =>
      documentation.save(
        authenticated(request),
        documentationInput.parse(request.body),
        z.object({ documentId: identifier }).strict().parse(request.params).documentId,
      ),
  );
  app.post(
    '/api/v1/admin/documentation/uploads',
    trace('documentation-media', 'reserve-upload'),
    async (request, reply) =>
      reply
        .code(201)
        .send(await documentation.reserve(authenticated(request), uploadInput.parse(request.body))),
  );
  app.post(
    '/api/v1/admin/documentation/uploads/:uploadId/complete',
    trace('documentation-media', 'complete-upload'),
    async (request) => {
      z.object({})
        .strict()
        .parse(request.body === undefined ? {} : request.body);
      return documentation.complete(
        authenticated(request),
        z.object({ uploadId: z.uuid() }).strict().parse(request.params).uploadId,
      );
    },
  );
  app.delete(
    '/api/v1/admin/documentation/uploads/:uploadId',
    trace('documentation-media', 'cancel-upload'),
    async (request) =>
      documentation.cancel(
        authenticated(request),
        z.object({ uploadId: z.uuid() }).strict().parse(request.params).uploadId,
      ),
  );
  app.get(
    '/api/v1/documentation/:documentId/assets/:assetId/content',
    trace('documentation-media', 'stream'),
    async (request, reply) => {
      const params = z
          .object({ documentId: identifier, assetId: assetReference })
          .strict()
          .parse(request.params),
        range =
          request.headers.range === undefined
            ? undefined
            : z.string().max(80).parse(request.headers.range),
        abort = new AbortController();
      request.raw.once('aborted', () => abort.abort());
      reply.raw.once('close', () => abort.abort());
      const content = await documentation.content(
        authenticated(request),
        params.documentId,
        params.assetId,
        range,
        abort.signal,
      );
      const disposition =
          content.kind === 'document' || content.contentType === 'application/octet-stream'
            ? 'attachment'
            : 'inline',
        filename = encodeURIComponent(content.name).replace(
          /['()*]/g,
          (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        );
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .header('Accept-Ranges', 'bytes')
        .header(
          'Content-Disposition',
          `${disposition}; filename="guide-attachment"; filename*=UTF-8''${filename}`,
        )
        .type(content.contentType);
      if (content.size !== undefined) reply.header('Content-Length', String(content.size));
      if (content.etag) reply.header('ETag', content.etag);
      if (content.contentRange) reply.code(206).header('Content-Range', content.contentRange);
      return reply.send(content.body);
    },
  );
  app.patch(
    '/api/v1/admin/documentation/:documentId/status',
    trace('documentation', 'set-status'),
    async (request) =>
      documentation.setStatus(
        authenticated(request),
        z.object({ documentId: identifier }).strict().parse(request.params).documentId,
        statusInput.parse(request.body).active,
      ),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/payment-terminals/next-name',
    trace('payment-terminal', 'next-name'),
    async (request) =>
      terminals.nextName(
        authenticated(request),
        scope.parse(request.params).storeId,
        z.object({ provider: terminalProvider }).strict().parse(request.query).provider,
      ),
  );
  app.post(
    '/api/v1/admin/stores/:storeId/payment-terminals',
    trace('payment-terminal', 'create'),
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await terminals.create(
            authenticated(request),
            scope.parse(request.params).storeId,
            terminalInput.parse(request.body),
          ),
        ),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/payment-terminals/:provider/:terminalId',
    trace('payment-terminal', 'read'),
    async (request) => {
      const params = terminalScope.parse(request.params);
      return wire(
        await terminals.detail(
          authenticated(request),
          params.storeId,
          params.provider,
          params.terminalId,
        ),
      );
    },
  );
  app.put(
    '/api/v1/admin/stores/:storeId/payment-terminals/:provider/:terminalId',
    trace('payment-terminal', 'update'),
    async (request) => {
      const params = terminalScope.parse(request.params),
        input = terminalInput.parse(request.body);
      if (input.provider !== params.provider)
        throw new AppError(
          400,
          'TERMINAL_PROVIDER_MISMATCH',
          'Terminal provider must match its resource.',
        );
      return terminals.update(authenticated(request), params.storeId, params.terminalId, input);
    },
  );
  app.delete(
    '/api/v1/admin/stores/:storeId/payment-terminals/:provider/:terminalId',
    trace('payment-terminal', 'delete'),
    async (request) => {
      const params = terminalScope.parse(request.params);
      return terminals.remove(
        authenticated(request),
        params.storeId,
        params.provider,
        params.terminalId,
      );
    },
  );
  return {
    service,
    checkins,
    inventory,
    support,
    terminals,
    documentation,
    settings,
    imports,
    mfa,
    storeImages,
    access,
    operatorAdministration,
    slack,
    locations,
  };
}
