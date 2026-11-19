import { randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { createProductSyncAdapter } from '../administration/product-sync.js';
import { readAdministrationWorkerOptions } from '../administration/worker-options.js';
import { inventoryPullBody } from './maintenance-domain.js';
import type { CatalogMaintenanceOptions } from './maintenance-options.js';
import { tracedFetch } from '../../observability/context.js';

export interface MaintenanceTransports {
  /**
   * `InventorySyncView` POST to `INVENTORY_SYNC_URL` (core/views.py:1564-1611). Legacy ignores
   * the response status; the status is returned for logging only. Throws on network failure.
   */
  inventory?: (productIds: string[], mode: 'manual' | 'csv') => Promise<number>;
  /** `Helpers.sync_pos_product(ids, is_troubleshoot)` (helpers/helpers.py:192-203). */
  products?: (
    productIds: string[],
    context: { userId: string; requestId: string; troubleshoot: boolean },
  ) => Promise<void>;
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
      !(config.NODE_ENV !== 'production' && local && url.protocol === 'http:'))
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
  fetcher: typeof fetch = tracedFetch,
): MaintenanceTransports {
  const result: MaintenanceTransports = {};
  if (options.INVENTORY_SYNC_URL && options.INVENTORY_SYNC_API_KEY) {
    const target = inventoryTarget(config, options.INVENTORY_SYNC_URL),
      secret = options.INVENTORY_SYNC_API_KEY;
    result.inventory = async (productIds, mode) => {
      const response = await fetcher(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': secret },
        body: inventoryPullBody({ kind: 'inventory-pull', mode, productIds }),
        redirect: 'error',
        signal: AbortSignal.timeout(options.INVENTORY_SYNC_HTTP_TIMEOUT_MS),
      });
      try {
        await response.body?.cancel();
      } catch {
        /* Legacy never reads the response body. */
      }
      return response.status;
    };
  }
  const productAdapter = createProductSyncAdapter(
    config,
    readAdministrationWorkerOptions(env),
    fetcher,
  );
  if (productAdapter)
    result.products = (productIds, context) =>
      productAdapter(randomUUID(), productIds, {
        operatorId: context.userId,
        requestId: context.requestId,
        troubleshoot: context.troubleshoot,
      });
  return result;
}
