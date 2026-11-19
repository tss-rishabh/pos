import { readStoreDefaultOperatorOptions } from './store-default-operators.js';
import { administrationCollectionPageQuery } from './collection-page.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { registerAdministrationStoreDetails } from './store-detail-routes.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import {
  noBody,
  noQuery,
  requestHeaders,
  routeSchema,
  transportHeaders,
} from '../../domain/route-validation.js';
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
  storageFormInput,
  locationCodeInput,
  deliverySlotInput,
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
import { FormInvalid, storeFormInput } from './store-form.js';
import { registerStoreImages } from './store-image-routes.js';
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
import { csvUploadInput, templateInput, uploadIdInput, uploadListInput } from './import-domain.js';
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
const slotScope = scope.extend({ slotId: identifier });
const documentScope = z.object({ documentId: identifier }).strict();
const uploadScope = z.object({ uploadId: z.uuid() }).strict();
const assetScope = z.object({ documentId: identifier, assetId: assetReference }).strict();
const rangeHeader = z.string().max(80);
const assetContentHeaders = requestHeaders({ range: rangeHeader.optional() });
const terminalProviderQuery = z.object({ provider: terminalProvider }).strict();
const salespersonPurpose = { purpose: z.literal('checkout').optional() };
const storeSalespersonQuery = personPageQuery.extend(salespersonPurpose);
const storeSalespersonSearch = administrationCollectionPageQuery.extend(salespersonPurpose);
const trace = (resource: string, action: string) => ({
  config: { trace: { module: 'administration', resource, action } },
});
const wire = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as unknown;

/** Legacy forms re-render with per-field errors; return them with the field names. */
async function sendForm(reply: FastifyReply, status: number, run: () => Promise<unknown>) {
  try {
    return reply.code(status).send(await run());
  } catch (error) {
    if (error instanceof FormInvalid)
      return reply.code(400).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: reply.request.id,
          fields: error.fields,
        },
      });
    throw error;
  }
}

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
  const storeImages = storeImageService(config, db, options.storeImageStore, ephemeral);
  const service = administrationService(config, db, {
      ...storeDefaults,
      ...options,
      ephemeral,
      storeImages,
    }),
    checkins = checkInService(db, config),
    inventory = inventoryService(config, db, options),
    support = supportService(config, db);
  const createOperator = operatorCreator(config, db);
  // Sorted cursors can contain contact/text values; the application keeps them in private POST bodies.
  app.post(
    '/api/v1/admin/stores/search',
    {
      ...trace('store', 'search'),
      ...routeSchema({
        querystring: noQuery,
        body: administrationCollectionPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
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
    },
  );
  app.post(
    '/api/v1/admin/stores/:storeId/counters/search',
    {
      ...trace('counter', 'search'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: administrationCollectionPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
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
    {
      ...trace('storage', 'search'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: administrationCollectionPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
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
  const documentation = documentationService(
    config,
    db,
    {
      ...options,
      documentationLog:
        options.documentationLog ??
        ((event) => app.log.warn(event, 'Guide attachment deletion failed')),
    },
    ephemeral,
  );
  app.post(
    '/api/v1/documentation/search',
    {
      ...trace('documentation', 'search'),
      ...routeSchema({
        querystring: noQuery,
        body: documentationPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
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
  const settings = settingsService(config, db, {
    ...options,
    log: options.log ?? ((level, event, message) => app.log[level](event, message)),
  });
  const mfa = operatorMfaService(config, db, undefined, undefined, ephemeral);
  registerStoreImages(app, storeImages);
  const operatorAdministration = operatorAdministrationService(
    config,
    db,
    invalidateOperatorAuthentication,
    options,
  );
  registerOperatorAdministration(app, operatorAdministration);
  const slack = slackConnectionService(config, db, options, ephemeral);
  registerSlackConnections(app, config, slack);
  const locations = locationLookupService(db);
  registerLocationLookups(app, locations);
  const enrollmentScope = operatorScope.extend({ enrollmentId: z.uuid() });
  app.get(
    '/api/v1/admin/operators/:operatorId/mfa',
    {
      ...trace('operator-mfa', 'read'),
      ...routeSchema({ params: operatorScope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request, reply) =>
      reply
        .header('Cache-Control', 'no-store')
        .send(
          await mfa.read(authenticated(request), operatorScope.parse(request.params).operatorId),
        ),
  );
  app.post(
    '/api/v1/admin/operators/:operatorId/mfa-enrollments',
    {
      ...trace('operator-mfa-enrollment', 'create'),
      ...routeSchema({
        params: operatorScope,
        querystring: noQuery,
        body: mfaEnrollmentInput,
        headers: transportHeaders,
      }),
    },
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
    {
      ...trace('operator-mfa-enrollment', 'verify'),
      ...routeSchema({
        params: enrollmentScope,
        querystring: noQuery,
        body: mfaVerificationInput,
        headers: transportHeaders,
      }),
    },
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
    {
      ...trace('operator-mfa-enrollment', 'cancel'),
      ...routeSchema({
        params: enrollmentScope,
        querystring: noQuery,
        body: noBody,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      const params = enrollmentScope.parse(request.params);
      return reply
        .header('Cache-Control', 'no-store')
        .send(await mfa.cancel(authenticated(request), params.operatorId, params.enrollmentId));
    },
  );
  app.put(
    '/api/v1/admin/operators/:operatorId/mfa',
    {
      ...trace('operator-mfa', 'update'),
      ...routeSchema({
        params: operatorScope,
        querystring: noQuery,
        body: mfaControlInput,
        headers: transportHeaders,
      }),
    },
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
    {
      ...trace('inventory-import', 'capabilities'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => {
      noQuery.parse(request.query);
      return imports.capabilities(authenticated(request));
    },
  );
  app.get(
    '/api/v1/admin/inventory-imports/template',
    {
      ...trace('inventory-import', 'download-template'),
      ...routeSchema({ querystring: templateInput, headers: transportHeaders }),
    },
    async (request, reply) => {
      const { type } = templateInput.parse(request.query);
      const file = imports.template(authenticated(request), type);
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${file.filename}"`)
        .header('Cache-Control', 'no-store')
        .send(file.content);
    },
  );
  app.post(
    '/api/v1/admin/inventory-imports',
    {
      ...trace('inventory-import', 'create'),
      ...routeSchema({ querystring: noQuery, body: csvUploadInput, headers: transportHeaders }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      return reply
        .code(201)
        .send(await imports.upload(authenticated(request), csvUploadInput.parse(request.body)));
    },
  );
  app.get(
    '/api/v1/admin/inventory-imports',
    {
      ...trace('inventory-import', 'list'),
      ...routeSchema({ querystring: uploadListInput, headers: transportHeaders }),
    },
    async (request) => imports.list(authenticated(request), uploadListInput.parse(request.query)),
  );
  app.get(
    '/api/v1/admin/inventory-imports/:uploadId',
    {
      ...trace('inventory-import', 'read'),
      ...routeSchema({ params: uploadIdInput, querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => {
      noQuery.parse(request.query);
      return imports.detail(authenticated(request), uploadIdInput.parse(request.params).uploadId);
    },
  );
  app.get(
    '/api/v1/admin/stores',
    {
      ...trace('store', 'list'),
      ...routeSchema({ querystring: administrationCollectionPageQuery, headers: transportHeaders }),
    },
    async (request) =>
      wire(
        await service.stores(
          authenticated(request),
          administrationCollectionPageQuery.parse(request.query),
        ),
      ),
  );
  app.get(
    '/api/v1/admin/stores/:storeId',
    {
      ...trace('store', 'read'),
      ...routeSchema({ params: scope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request) =>
      wire(await service.store(authenticated(request), scope.parse(request.params).storeId)),
  );
  app.post(
    '/api/v1/admin/stores',
    {
      ...trace('store', 'create'),
      ...routeSchema({ querystring: noQuery, body: storeFormInput, headers: transportHeaders }),
    },
    async (request, reply) =>
      sendForm(reply, 201, () =>
        service.createStore(authenticated(request), storeFormInput.parse(request.body)),
      ),
  );
  app.put(
    '/api/v1/admin/stores/:storeId',
    {
      ...trace('store', 'update'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: storeFormInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) =>
      sendForm(reply, 200, () =>
        service.updateStore(
          authenticated(request),
          scope.parse(request.params).storeId,
          storeFormInput.parse(request.body),
        ),
      ),
  );
  app.get(
    '/api/v1/admin/resource-stores',
    {
      ...trace('store', 'list-resource-stores'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => wire({ data: await service.resourceStores(authenticated(request)) }),
  );
  app.post(
    '/api/v1/admin/counters/search',
    {
      ...trace('counter', 'search-all'),
      ...routeSchema({
        querystring: noQuery,
        body: administrationCollectionPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          wire(
            await service.allCounters(
              authenticated(request),
              administrationCollectionPageQuery.parse(request.body),
            ),
          ),
        );
    },
  );
  app.post(
    '/api/v1/admin/storages/search',
    {
      ...trace('storage', 'search-all'),
      ...routeSchema({
        querystring: noQuery,
        body: administrationCollectionPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          wire(
            await service.allStorages(
              authenticated(request),
              administrationCollectionPageQuery.parse(request.body),
            ),
          ),
        );
    },
  );
  app.patch(
    '/api/v1/admin/stores/:storeId/status',
    {
      ...trace('store', 'set-status'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: statusInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      service.setStoreStatus(
        authenticated(request),
        scope.parse(request.params).storeId,
        statusInput.parse(request.body).active,
      ),
  );
  app.get(
    '/api/v1/admin/countries',
    {
      ...trace('country', 'list'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => wire({ data: await service.countries(authenticated(request)) }),
  );
  app.get(
    '/api/v1/admin/store-location-codes',
    {
      ...trace('store-location', 'list'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => ({ data: await service.locations(authenticated(request)) }),
  );
  app.post(
    '/api/v1/admin/store-location-codes',
    {
      ...trace('store-location', 'create'),
      ...routeSchema({ querystring: noQuery, body: locationCodeInput, headers: transportHeaders }),
    },
    async (request) =>
      service.addLocationCode(authenticated(request), locationCodeInput.parse(request.body).code),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/counters',
    {
      ...trace('counter', 'list'),
      ...routeSchema({
        params: scope,
        querystring: administrationCollectionPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request) =>
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
    {
      ...trace('counter', 'create'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: counterInput,
        headers: transportHeaders,
      }),
    },
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
    {
      ...trace('counter', 'set-status'),
      ...routeSchema({
        params: counterScope,
        querystring: noQuery,
        body: statusInput,
        headers: transportHeaders,
      }),
    },
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
  app.get(
    '/api/v1/admin/stores/:storeId/storages',
    {
      ...trace('storage', 'list'),
      ...routeSchema({
        params: scope,
        querystring: administrationCollectionPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request) =>
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
    {
      ...trace('storage', 'create'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: storageFormInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) =>
      sendForm(reply, 201, () =>
        service.createStorage(
          authenticated(request),
          scope.parse(request.params).storeId,
          storageFormInput.parse(request.body),
        ),
      ),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/storages/:storageId',
    {
      ...trace('storage', 'read'),
      ...routeSchema({ params: storageScope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => {
      const params = storageScope.parse(request.params);
      return wire(await service.storage(authenticated(request), params.storeId, params.storageId));
    },
  );
  app.put(
    '/api/v1/admin/stores/:storeId/storages/:storageId',
    {
      ...trace('storage', 'update'),
      ...routeSchema({
        params: storageScope,
        querystring: noQuery,
        body: storageFormInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      const params = storageScope.parse(request.params);
      return sendForm(reply, 200, () =>
        service.updateStorage(
          authenticated(request),
          params.storeId,
          params.storageId,
          storageFormInput.parse(request.body),
        ),
      );
    },
  );
  app.patch(
    '/api/v1/admin/stores/:storeId/storages/:storageId/status',
    {
      ...trace('storage', 'set-status'),
      ...routeSchema({
        params: storageScope,
        querystring: noQuery,
        body: statusInput,
        headers: transportHeaders,
      }),
    },
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
  app.get(
    '/api/v1/admin/salespeople',
    {
      ...trace('salesperson', 'list'),
      ...routeSchema({ querystring: personPageQuery, headers: transportHeaders }),
    },
    async (request, reply) =>
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
    {
      ...trace('salesperson', 'search'),
      ...routeSchema({
        querystring: noQuery,
        body: administrationCollectionPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
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
    {
      ...trace('store-salesperson', 'list'),
      ...routeSchema({
        params: scope,
        querystring: storeSalespersonQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      const { purpose, ...query } = storeSalespersonQuery.parse(request.query);
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
    {
      ...trace('store-salesperson', 'search'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: storeSalespersonSearch,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      const { purpose, ...page } = storeSalespersonSearch.parse(request.body);
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
  app.post(
    '/api/v1/admin/salespeople',
    {
      ...trace('salesperson', 'create'),
      ...routeSchema({ querystring: noQuery, body: salespersonInput, headers: transportHeaders }),
    },
    async (request, reply) =>
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
    {
      ...trace('salesperson', 'update'),
      ...routeSchema({
        params: salespersonScope,
        querystring: noQuery,
        body: salespersonInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      service.updateSalesperson(
        authenticated(request),
        salespersonScope.parse(request.params).salespersonId,
        salespersonInput.parse(request.body),
      ),
  );
  app.patch(
    '/api/v1/admin/salespeople/:salespersonId/status',
    {
      ...trace('salesperson', 'set-status'),
      ...routeSchema({
        params: salespersonScope,
        querystring: noQuery,
        body: statusInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      service.setSalespersonStatus(
        authenticated(request),
        salespersonScope.parse(request.params).salespersonId,
        statusInput.parse(request.body).active,
      ),
  );
  app.put(
    '/api/v1/admin/salespeople/:salespersonId/stores',
    {
      ...trace('salesperson-assignment', 'replace'),
      ...routeSchema({
        params: salespersonScope,
        querystring: noQuery,
        body: salespersonAssignmentInput,
        headers: transportHeaders,
      }),
    },
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
  app.get(
    '/api/v1/admin/operators',
    {
      ...trace('operator', 'list'),
      ...routeSchema({ querystring: personPageQuery, headers: transportHeaders }),
    },
    async (request, reply) =>
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
    {
      ...trace('operator', 'search'),
      ...routeSchema({
        querystring: noQuery,
        body: administrationCollectionPageQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
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
  app.post(
    '/api/v1/admin/operators',
    {
      ...trace('operator', 'create'),
      ...routeSchema({
        querystring: noQuery,
        body: operatorCreateInput,
        headers: transportHeaders,
      }),
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await createOperator(authenticated(request), operatorCreateInput.parse(request.body)),
        ),
  );
  app.put(
    '/api/v1/admin/operators/:operatorId',
    {
      ...trace('operator', 'update'),
      ...routeSchema({
        params: operatorScope,
        querystring: noQuery,
        body: operatorInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      service.updateOperator(
        authenticated(request),
        operatorScope.parse(request.params).operatorId,
        operatorInput.parse(request.body),
      ),
  );
  app.patch(
    '/api/v1/admin/operators/:operatorId/status',
    {
      ...trace('operator', 'set-status'),
      ...routeSchema({
        params: operatorScope,
        querystring: noQuery,
        body: statusInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      service.setOperatorStatus(
        authenticated(request),
        operatorScope.parse(request.params).operatorId,
        statusInput.parse(request.body).active,
      ),
  );
  app.put(
    '/api/v1/admin/operators/:operatorId/stores',
    {
      ...trace('operator-assignment', 'replace'),
      ...routeSchema({
        params: operatorScope,
        querystring: noQuery,
        body: assignmentInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      service.assignOperatorStores(
        authenticated(request),
        operatorScope.parse(request.params).operatorId,
        assignmentInput.parse(request.body).storeIds,
      ),
  );
  app.get(
    '/api/v1/operators/me/check-in',
    {
      ...trace('operator-checkin', 'read'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => ({
      data: await checkins.current(authenticated(request)),
    }),
  );
  app.put(
    '/api/v1/operators/me/check-in',
    {
      ...trace('operator-checkin', 'set'),
      ...routeSchema({ querystring: noQuery, body: checkInInput, headers: transportHeaders }),
    },
    async (request) => {
      const body = checkInInput.parse(request.body);
      return checkins.set(authenticated(request), body.storeId, body.counterId);
    },
  );
  app.delete(
    '/api/v1/operators/me/check-in',
    {
      ...trace('operator-checkin', 'clear'),
      ...routeSchema({ querystring: noQuery, body: noBody, headers: transportHeaders }),
    },
    async (request, reply) => {
      await checkins.clear(authenticated(request));
      return reply.code(204).send();
    },
  );
  app.get(
    '/api/v1/admin/stores/:storeId/inventory',
    {
      ...trace('store-inventory', 'list'),
      ...routeSchema({ params: scope, querystring: pageQuery, headers: transportHeaders }),
    },
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
    {
      ...trace('store-inventory', 'set-stock'),
      ...routeSchema({
        params: productScope,
        querystring: noQuery,
        body: stockInput,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      const params = productScope.parse(request.params),
        body = stockInput.parse(request.body);
      return inventory.setStock(
        authenticated(request),
        params.storeId,
        params.productId,
        body.stock,
        body.expectedStock,
      );
    },
  );
  app.patch(
    '/api/v1/admin/stores/:storeId/inventory/:productId/visibility',
    {
      ...trace('store-inventory', 'set-visibility'),
      ...routeSchema({
        params: productScope,
        querystring: noQuery,
        body: visibilityInput,
        headers: transportHeaders,
      }),
    },
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
      );
    },
  );
  app.get(
    '/api/v1/admin/stores/:storeId/inventory/:productId/logs',
    {
      ...trace('inventory-history', 'list'),
      ...routeSchema({ params: productScope, querystring: pageQuery, headers: transportHeaders }),
    },
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
    {
      ...trace('delivery-slot', 'list'),
      ...routeSchema({ params: scope, querystring: noQuery, headers: transportHeaders }),
    },
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
    {
      ...trace('delivery-slot', 'create'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: deliverySlotInput,
        headers: transportHeaders,
      }),
    },
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
    {
      ...trace('delivery-slot', 'update'),
      ...routeSchema({
        params: slotScope,
        querystring: noQuery,
        body: deliverySlotUpdateInput,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      const params = slotScope.parse(request.params);
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
    {
      ...trace('delivery-slot', 'set-availability'),
      ...routeSchema({
        params: slotScope,
        querystring: noQuery,
        body: deliveryAvailabilityInput,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      const params = slotScope.parse(request.params);
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
    {
      ...trace('delivery-slot', 'set-all-availability'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: allDeliveryAvailabilityInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      settings.setAllDeliveryAvailability(
        authenticated(request),
        scope.parse(request.params).storeId,
        allDeliveryAvailabilityInput.parse(request.body),
      ),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/payment-terminals',
    {
      ...trace('payment-terminal', 'list'),
      ...routeSchema({ params: scope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request) =>
      wire({
        data: await support.paymentTerminals(
          authenticated(request),
          scope.parse(request.params).storeId,
        ),
      }),
  );
  app.get(
    '/api/v1/admin/general-settings',
    {
      ...trace('general-setting', 'read'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => ({
      data: await settings.generalSettings(authenticated(request)),
    }),
  );
  app.put(
    '/api/v1/admin/general-settings/delivery-stock-threshold',
    {
      ...trace('general-setting', 'update-stock-threshold'),
      ...routeSchema({ querystring: noQuery, body: thresholdInput, headers: transportHeaders }),
    },
    async (request) =>
      settings.updateThreshold(authenticated(request), thresholdInput.parse(request.body)),
  );
  app.put(
    '/api/v1/admin/general-settings/order-creation-buffer',
    {
      ...trace('general-setting', 'update-order-buffer'),
      ...routeSchema({ querystring: noQuery, body: orderBufferInput, headers: transportHeaders }),
    },
    async (request) =>
      settings.updateOrderBuffer(authenticated(request), orderBufferInput.parse(request.body)),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/ecommerce-settings',
    {
      ...trace('ecommerce-setting', 'read'),
      ...routeSchema({ params: scope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request) =>
      settings.ecommerceSettings(authenticated(request), scope.parse(request.params).storeId),
  );
  app.put(
    '/api/v1/admin/stores/:storeId/ecommerce-settings',
    {
      ...trace('ecommerce-setting', 'update'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: ecommerceInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      settings.updateEcommerce(
        authenticated(request),
        scope.parse(request.params).storeId,
        ecommerceInput.parse(request.body),
      ),
  );
  app.get(
    '/api/v1/documentation',
    {
      ...trace('documentation', 'list'),
      ...routeSchema({ querystring: documentationPageQuery, headers: transportHeaders }),
    },
    async (request) =>
      wire(
        await documentation.list(
          authenticated(request),
          documentationPageQuery.parse(request.query),
        ),
      ),
  );
  app.get(
    '/api/v1/admin/documentation/media-capabilities',
    {
      ...trace('documentation-media', 'capabilities'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => documentation.capabilities(authenticated(request)),
  );
  app.get(
    '/api/v1/documentation/:documentId',
    {
      ...trace('documentation', 'read'),
      ...routeSchema({ params: documentScope, querystring: noQuery, headers: transportHeaders }),
    },
    async (request) =>
      documentation.detail(authenticated(request), documentScope.parse(request.params).documentId),
  );
  app.post(
    '/api/v1/admin/documentation',
    {
      ...trace('documentation', 'create'),
      ...routeSchema({ querystring: noQuery, body: documentationInput, headers: transportHeaders }),
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await documentation.save(authenticated(request), documentationInput.parse(request.body)),
        ),
  );
  app.put(
    '/api/v1/admin/documentation/:documentId',
    {
      ...trace('documentation', 'update'),
      ...routeSchema({
        params: documentScope,
        querystring: noQuery,
        body: documentationInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      documentation.save(
        authenticated(request),
        documentationInput.parse(request.body),
        documentScope.parse(request.params).documentId,
      ),
  );
  app.post(
    '/api/v1/admin/documentation/uploads',
    {
      ...trace('documentation-media', 'reserve-upload'),
      ...routeSchema({ querystring: noQuery, body: uploadInput, headers: transportHeaders }),
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await documentation.reserve(authenticated(request), uploadInput.parse(request.body))),
  );
  app.post(
    '/api/v1/admin/documentation/uploads/:uploadId/complete',
    {
      ...trace('documentation-media', 'complete-upload'),
      ...routeSchema({
        params: uploadScope,
        querystring: noQuery,
        body: noBody,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      noBody.parse(request.body ?? null);
      return documentation.complete(
        authenticated(request),
        uploadScope.parse(request.params).uploadId,
      );
    },
  );
  app.delete(
    '/api/v1/admin/documentation/uploads/:uploadId',
    {
      ...trace('documentation-media', 'cancel-upload'),
      ...routeSchema({
        params: uploadScope,
        querystring: noQuery,
        body: noBody,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      documentation.cancel(authenticated(request), uploadScope.parse(request.params).uploadId),
  );
  app.get(
    '/api/v1/documentation/:documentId/assets/:assetId/content',
    {
      ...trace('documentation-media', 'stream'),
      ...routeSchema({ params: assetScope, querystring: noQuery, headers: assetContentHeaders }),
    },
    async (request, reply) => {
      const params = assetScope.parse(request.params),
        range =
          request.headers.range === undefined
            ? undefined
            : rangeHeader.parse(request.headers.range),
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
    {
      ...trace('documentation', 'set-status'),
      ...routeSchema({
        params: documentScope,
        querystring: noQuery,
        body: statusInput,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      documentation.setStatus(
        authenticated(request),
        documentScope.parse(request.params).documentId,
        statusInput.parse(request.body).active,
      ),
  );
  app.get(
    '/api/v1/admin/stores/:storeId/payment-terminals/next-name',
    {
      ...trace('payment-terminal', 'next-name'),
      ...routeSchema({
        params: scope,
        querystring: terminalProviderQuery,
        headers: transportHeaders,
      }),
    },
    async (request) =>
      terminals.nextName(
        authenticated(request),
        scope.parse(request.params).storeId,
        terminalProviderQuery.parse(request.query).provider,
      ),
  );
  app.post(
    '/api/v1/admin/stores/:storeId/payment-terminals',
    {
      ...trace('payment-terminal', 'create'),
      ...routeSchema({
        params: scope,
        querystring: noQuery,
        body: terminalInput,
        headers: transportHeaders,
      }),
    },
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
    {
      ...trace('payment-terminal', 'read'),
      ...routeSchema({ params: terminalScope, querystring: noQuery, headers: transportHeaders }),
    },
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
    {
      ...trace('payment-terminal', 'update'),
      ...routeSchema({
        params: terminalScope,
        querystring: noQuery,
        body: terminalInput,
        headers: transportHeaders,
      }),
    },
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
    {
      ...trace('payment-terminal', 'delete'),
      ...routeSchema({
        params: terminalScope,
        querystring: noQuery,
        body: noBody,
        headers: transportHeaders,
      }),
    },
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
    operatorAdministration,
    slack,
    locations,
  };
}
