import type { FastifyInstance } from 'fastify';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import type { JobProducer } from '../../../jobs/contract.js';
import {
  createProductSyncAdapter,
  type ProductSyncAdapter,
} from '../../administration/product-sync.js';
import type { StockProcedure } from '../../administration/stock-procedure.js';
import { readAdministrationWorkerOptions } from '../../administration/worker-options.js';
import type { CheckoutSessionStore } from '../session-store.js';
import { configuredStateStore, type PosStateStore } from '../state-store.js';
import {
  apiV2CancelPosOrderClient,
  cancelPosOrderUrl,
  type CancelPosOrderClient,
} from './api-v2.js';
import { cancellationInputSchema, cancellationParamsSchema } from './contracts.js';
import type { PendingCancellationOptions } from './options.js';
import { pendingCancellationRepository } from './repository.js';

export interface PendingCancellationRegistrationOptions extends PendingCancellationOptions {
  stateStore?: PosStateStore;
  sessions?: CheckoutSessionStore;
  jobs?: JobProducer;
  stockProcedure?: StockProcedure;
  /** Tests inject a fake API-v2; production builds it from the legacy URL settings. */
  client?: CancelPosOrderClient;
  syncProducts?: ProductSyncAdapter;
}

/** Legacy `ajax-order-cancel/` (order/urls.py:37, AjaxOrderCancelView order/views.py:2900). */
export function registerPendingOrderCancellations(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: PendingCancellationRegistrationOptions,
) {
  const target = options.client ? undefined : cancelPosOrderUrl(config, options);
  const service = pendingCancellationRepository(db, config, {
      stateStore: options.stateStore ?? configuredStateStore(config),
      client: options.client ?? (target ? apiV2CancelPosOrderClient(target) : undefined),
      stockProcedure: options.stockProcedure,
      syncProducts:
        options.syncProducts ?? createProductSyncAdapter(config, readAdministrationWorkerOptions()),
      logger: app.log,
    }),
    base = '/api/v1/stores/:storeId/orders/:orderId/cancellations',
    trace = (action: string) => ({
      config: { trace: { module: 'checkout', resource: 'pending-order-cancellation', action } },
    });
  app.get(base, trace('read'), (request) => {
    const p = cancellationParamsSchema.parse(request.params);
    return service.context(authenticated(request), p.storeId, p.orderId);
  });
  app.post(base, trace('create'), async (request) => {
    const p = cancellationParamsSchema.parse(request.params);
    cancellationInputSchema.parse(request.body ?? {});
    return service.create(authenticated(request), p.storeId, p.orderId);
  });
  return service;
}
