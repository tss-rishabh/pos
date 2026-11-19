import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { JobLogger } from '../../jobs/runtime.js';
import { currentRequestTrace, tracedFetch } from '../../observability/context.js';
import { AppError } from '../../domain/errors.js';
import type { InventorySynchronizationContext } from './inventory.js';
import type { AdministrationWorkerOptions } from './worker-options.js';

/**
 * Legacy posts the whole list in one body (a CSV import can name every record's product) and
 * sends whatever integer a CSV record carried.
 */
const productIds = z
  .array(z.string().regex(/^-?\d{1,30}$/))
  .min(1)
  .max(20000);
const eventId = z.string().regex(/^[A-Za-z0-9_-]{1,36}$/);
export type ProductSyncContext = Pick<
  InventorySynchronizationContext,
  'operatorId' | 'requestId' | 'troubleshoot'
> & { storeId?: string };
export type ProductSyncAdapter = (
  id: string,
  ids: string[],
  context: ProductSyncContext,
  signal?: AbortSignal,
) => Promise<void>;

/** Python requests serializes integer IDs as JSON numbers; Number() would lose BIGINT precision. */
export function productSynchronizationBody(ids: string[], troubleshoot = false): string {
  const selected = productIds.parse(ids);
  return `{"product_id_list":[${selected.join(',')}]${troubleshoot ? ',"is_troubleshoot":true' : ''}}`;
}
/**
 * `requireReplaySafe` (default true) keeps the gate for retrying callers (catalog maintenance).
 * Legacy `Helpers.sync_pos_product` (`helpers/helpers.py:192-202`) is a single unretried POST, so
 * the inline administration callers pass `false`.
 */
export function createProductSyncAdapter(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE' | 'TSS_API_BASE_URL' | 'TSS_API_MIGRATION_V2'>,
  options: AdministrationWorkerOptions,
  fetcher: typeof fetch = tracedFetch,
  { requireReplaySafe = true }: { requireReplaySafe?: boolean } = {},
): ProductSyncAdapter | undefined {
  const base =
    options.PRODUCT_SYNC_BASE_URL ||
    (config.TSS_API_MIGRATION_V2 ? options.MAIN_API_V2_URL : options.API_V2_URL) ||
    config.TSS_API_BASE_URL;
  if (
    !base ||
    !options.PRODUCT_SYNC_URI ||
    (requireReplaySafe && !options.PRODUCT_SYNC_REPLAY_SAFE)
  )
    return undefined;
  const target = new URL(base + options.PRODUCT_SYNC_URI),
    origin = new URL(base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (
    target.origin !== origin.origin ||
    target.username ||
    target.password ||
    origin.search ||
    origin.hash ||
    target.hash ||
    (target.protocol !== 'https:' &&
      !(config.NODE_ENV !== 'production' && local && target.protocol === 'http:')) ||
    (config.DEMO_MODE && !local)
  )
    throw new AppError(
      503,
      'PRODUCT_SYNC_CONFIGURATION_INVALID',
      'Configure an approved product synchronization endpoint.',
    );
  return async (id, ids, context, signal) => {
    eventId.parse(id);
    const body = productSynchronizationBody(ids, context.troubleshoot === true);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': id,
    };
    if (context.requestId && /^[A-Za-z0-9._-]{1,128}$/.test(context.requestId))
      headers['X-Request-Id'] = context.requestId;
    try {
      const response = await fetcher(target, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(options.PRODUCT_SYNC_HTTP_TIMEOUT_MS)])
          : AbortSignal.timeout(options.PRODUCT_SYNC_HTTP_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.status !== 200)
        throw new AppError(
          503,
          'PRODUCT_SYNC_REJECTED',
          'Product synchronization was not acknowledged.',
        );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        503,
        'PRODUCT_SYNC_UNAVAILABLE',
        'Product synchronization is unavailable.',
      );
    }
  };
}

/** Product IDs to re-sync, with the actor for log correlation only. */
export type ProductSynchronizer = (
  productIds: readonly string[],
  context: { operatorId: string; storeId?: string },
) => Promise<boolean>;

/**
 * Legacy `Helpers.sync_pos_product` / `GenericHelper.sync_pos_product`: called once, inline, after
 * the change is committed (`core/views.py:489,543,564,776`, `helpers/task_helpers.py:168-172,348-350`).
 * A failed or refused call is logged and swallowed (legacy logs a non-200), never retried and never
 * surfaced to the caller. Returns whether the endpoint acknowledged with 200.
 */
export function productSynchronizer(
  adapter: ProductSyncAdapter | undefined,
  log: JobLogger,
): ProductSynchronizer {
  return async (productIds, context) => {
    const trace = currentRequestTrace(),
      base = {
        module: 'administration',
        resource: 'product-sync',
        requestId: trace?.requestId ?? null,
        userId: context.operatorId,
        storeId: context.storeId ?? null,
        productCount: productIds.length,
      };
    if (!productIds.length) return true;
    if (!adapter) {
      log(
        'warn',
        {
          ...base,
          eventId: 'administration.product-sync.unconfigured',
          errorCode: 'PRODUCT_SYNC_UNCONFIGURED',
        },
        'Product synchronization is not configured',
      );
      return false;
    }
    try {
      await adapter(randomUUID(), [...productIds], {
        operatorId: context.operatorId,
        ...(context.storeId ? { storeId: context.storeId } : {}),
        ...(trace?.requestId ? { requestId: trace.requestId } : {}),
      });
      return true;
    } catch (error) {
      log(
        'warn',
        {
          ...base,
          eventId: 'administration.product-sync.failed',
          errorCode: error instanceof AppError ? error.code : 'PRODUCT_SYNC_UNAVAILABLE',
        },
        'Product not synced',
      );
      return false;
    }
  };
}
