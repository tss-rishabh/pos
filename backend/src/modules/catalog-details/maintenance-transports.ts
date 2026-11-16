import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { createProductSyncAdapter } from '../administration/product-sync.js';
import { readAdministrationWorkerOptions } from '../administration/worker-options.js';
import {
  inventoryPullBody,
  maintenanceHash,
  maintenancePayload,
  type MaintenancePayload,
} from './maintenance-domain.js';
import type { CatalogMaintenanceOptions } from './maintenance-options.js';
import { z } from 'zod';
const deliveryErrorCode = z.enum([
  'INVALID_INVENTORY_DELIVERY',
  'INVENTORY_PULL_NOT_ACKNOWLEDGED',
  'INVENTORY_PULL_OUTCOME_UNKNOWN',
  'INVALID_PRODUCT_DELIVERY',
  'PRODUCT_SYNC_OUTCOME_UNKNOWN',
  'CATALOG_DELIVERY_OUTCOME_UNKNOWN',
]);
export interface MaintenanceDeliveryContext {
  deliveryId: string;
  requestId: string;
  userId: string;
}
export interface MaintenanceTransport {
  identity: string;
  send: (payload: MaintenancePayload, context: MaintenanceDeliveryContext) => Promise<void>;
}
export interface MaintenanceTransports {
  inventory?: MaintenanceTransport;
  products?: MaintenanceTransport;
}
export class MaintenanceDeliveryError extends Error {
  readonly code: z.infer<typeof deliveryErrorCode>;
  constructor(
    public outcome: 'failed' | 'uncertain',
    code: string,
  ) {
    super('Catalog maintenance delivery was not acknowledged.');
    const parsed = deliveryErrorCode.safeParse(code);
    this.code = parsed.success ? parsed.data : 'CATALOG_DELIVERY_OUTCOME_UNKNOWN';
  }
}
function inventoryTarget(config: Config, value: string) {
  const url = new URL(value),
    local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(config.NODE_ENV !== 'production' && local && url.protocol === 'http:')) ||
    (config.DEMO_MODE && !local)
  )
    throw new AppError(
      503,
      'INVENTORY_SYNC_CONFIGURATION_INVALID',
      'Configure an approved inventory synchronization endpoint.',
    );
  return url;
}
export function createCatalogMaintenanceTransports(
  config: Config,
  options: CatalogMaintenanceOptions,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): MaintenanceTransports {
  const result: MaintenanceTransports = {};
  if (options.INVENTORY_SYNC_URL && options.INVENTORY_SYNC_API_KEY) {
    const target = inventoryTarget(config, options.INVENTORY_SYNC_URL),
      secret = options.INVENTORY_SYNC_API_KEY;
    result.inventory = {
      identity: maintenanceHash(target.href),
      async send(value, context) {
        const payload = maintenancePayload.parse(value);
        if (payload.kind !== 'inventory-pull')
          throw new MaintenanceDeliveryError('failed', 'INVALID_INVENTORY_DELIVERY');
        try {
          const response = await fetcher(target, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': secret,
              'Idempotency-Key': context.deliveryId,
              ...(/^[A-Za-z0-9._-]{1,128}$/.test(context.requestId)
                ? { 'X-Request-Id': context.requestId }
                : {}),
            },
            body: inventoryPullBody(payload),
            redirect: 'error',
            signal: AbortSignal.timeout(options.INVENTORY_SYNC_HTTP_TIMEOUT_MS),
          });
          try {
            await response.body?.cancel();
          } catch {
            /* The acknowledgement is the HTTP status, not the unused legacy response body. */
          }
          if (response.status >= 200 && response.status < 300) return;
          throw new MaintenanceDeliveryError(
            [400, 401, 403, 404, 422].includes(response.status) ? 'failed' : 'uncertain',
            'INVENTORY_PULL_NOT_ACKNOWLEDGED',
          );
        } catch (error) {
          if (error instanceof MaintenanceDeliveryError) throw error;
          throw new MaintenanceDeliveryError('uncertain', 'INVENTORY_PULL_OUTCOME_UNKNOWN');
        }
      },
    };
  }
  const productOptions = readAdministrationWorkerOptions(env),
    productAdapter = createProductSyncAdapter(config, productOptions, fetcher);
  if (productAdapter) {
    const base =
      productOptions.PRODUCT_SYNC_BASE_URL ||
      (config.TSS_API_MIGRATION_V2 ? productOptions.MAIN_API_V2_URL : productOptions.API_V2_URL) ||
      config.TSS_API_BASE_URL;
    result.products = {
      identity: maintenanceHash(new URL(base! + productOptions.PRODUCT_SYNC_URI!).href),
      async send(value, context) {
        const payload = maintenancePayload.parse(value);
        if (payload.kind !== 'product-sync')
          throw new MaintenanceDeliveryError('failed', 'INVALID_PRODUCT_DELIVERY');
        try {
          await productAdapter(context.deliveryId, payload.productIds, {
            operatorId: context.userId,
            requestId: context.requestId,
            troubleshoot: payload.troubleshoot,
          });
        } catch {
          throw new MaintenanceDeliveryError('uncertain', 'PRODUCT_SYNC_OUTCOME_UNKNOWN');
        }
      },
    };
  }
  return result;
}
