import type { Config } from '../../../config.js';
import { AppError } from '../../../domain/errors.js';
import { boundedJson } from '../../../domain/http-json.js';
import { identifier } from '../../../domain/validation.js';
import type { PendingCancellationOptions } from './options.js';

/**
 * API-v2 `pos/cancel-pos-order`, called exactly as legacy `AjaxOrderCancelView`
 * (order/views.py:2917-2928): base `MAIN_API_V2_URL` when `MIGRATION_TO_API_V2`, else `API_V2_URL`;
 * `POST {"user_id": <order customer>, "order_id": <order>}` with only `Content-Type: application/json`.
 * API-v2 owns the wallet, voucher and membership refunds and the `cancel_orders` row.
 */
export type CancelPosOrderOutcome =
  { accepted: true; body: unknown } | { accepted: false; status: number };
export interface CancelPosOrderClient {
  cancel(input: { userId: string; orderId: string }): Promise<CancelPosOrderOutcome>;
}

/** Python `json.dumps` spacing; IDs stay exact BIGINT digits instead of JS numbers. */
export function cancelPosOrderBody(userId: string, orderId: string): string {
  return `{"user_id": ${identifier.parse(userId)}, "order_id": ${identifier.parse(orderId)}}`;
}

export function cancelPosOrderUrl(
  config: Pick<Config, 'NODE_ENV' | 'TSS_API_BASE_URL' | 'TSS_API_MIGRATION_V2'>,
  options: PendingCancellationOptions,
): URL | undefined {
  const base =
    (config.TSS_API_MIGRATION_V2 ? options.mainApiV2Url : options.apiV2Url) ||
    config.TSS_API_BASE_URL;
  if (!base) return undefined;
  const target = new URL('pos/cancel-pos-order', base.endsWith('/') ? base : base + '/');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (
    target.username ||
    target.password ||
    (target.protocol !== 'https:' &&
      !(config.NODE_ENV !== 'production' && local && target.protocol === 'http:'))
  )
    throw new AppError(
      503,
      'ORDER_CANCEL_CONFIGURATION_INVALID',
      'The order cancellation service must use HTTPS.',
    );
  return target;
}

export function apiV2CancelPosOrderClient(
  target: URL,
  fetcher: typeof fetch = fetch,
  timeoutMs = 30_000,
): CancelPosOrderClient {
  return {
    async cancel({ userId, orderId }) {
      let response: Response;
      try {
        response = await fetcher(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: cancelPosOrderBody(userId, orderId),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new AppError(
          502,
          'ORDER_CANCEL_OUTCOME_UNKNOWN',
          'The order service did not answer. Check the order status before trying again.',
        );
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return { accepted: false, status: response.status };
      }
      try {
        // Legacy reads `response.json()` before any local write; an unreadable reply stops here.
        return { accepted: true, body: await boundedJson(response, 256_000) };
      } catch {
        throw new AppError(
          502,
          'ORDER_CANCEL_OUTCOME_UNKNOWN',
          'The order service reply was unreadable. Check the order status before trying again.',
        );
      }
    },
  };
}
