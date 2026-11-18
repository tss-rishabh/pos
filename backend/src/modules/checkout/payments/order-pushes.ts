import { z } from 'zod';
import type { Config } from '../../../config.js';
import { stringifyNumericJson } from '../../upstream.js';

/**
 * First-paid side effects that legacy calls synchronously after the paid write:
 * `Helpers.push_order_kinesis` (helpers/helpers.py:505-525) and
 * `Helpers.push_for_em` (helpers/helpers.py:1862-1874). Both are best effort:
 * legacy swallows every error and never retries, and so does this adapter.
 */
export interface OrderPushes {
  paid(orderId: string): Promise<void>;
}
export interface OrderPushEnvironment {
  orderProducerUrl?: string;
  orderProducerAppId?: string;
  orderProducerAppKey?: string;
  mainApiV2Url?: string;
}
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export function orderPushEnvironment(env: NodeJS.ProcessEnv = process.env): OrderPushEnvironment {
  const value = z
    .object({
      ORDER_PRODUCER_URL: optional(z.url()),
      ORDER_PRODUCER_APP_ID: optional(z.string().min(1).max(128)),
      ORDER_PRODUCER_APP_KEY: optional(z.string().min(1).max(1024)),
      MAIN_API_V2_URL: optional(z.url()),
    })
    .parse(env);
  return {
    orderProducerUrl: value.ORDER_PRODUCER_URL,
    orderProducerAppId: value.ORDER_PRODUCER_APP_ID,
    orderProducerAppKey: value.ORDER_PRODUCER_APP_KEY,
    mainApiV2Url: value.MAIN_API_V2_URL,
  };
}
export type OrderPushObserver = (event: {
  kind: 'order-kinesis' | 'order-engagement';
  outcome: 'sent' | 'failed' | 'unconfigured';
}) => void;

export function orderPushes(
  config: Config,
  environment: OrderPushEnvironment,
  fetcher: typeof fetch = fetch,
  observe?: OrderPushObserver,
): OrderPushes {
  const safe = (raw: string | undefined) => {
    if (!raw) return null;
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      return null;
    return url;
  };
  const producer = safe(environment.orderProducerUrl),
    engagement = environment.mainApiV2Url
      ? safe(environment.mainApiV2Url.replace(/\/?$/, '/') + 'em-check')
      : null;
  async function post(
    kind: 'order-kinesis' | 'order-engagement',
    url: URL | null,
    headers: Record<string, string>,
    body: unknown,
  ) {
    if (!url) {
      observe?.({ kind, outcome: 'unconfigured' });
      return;
    }
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: stringifyNumericJson(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      observe?.({ kind, outcome: response.ok ? 'sent' : 'failed' });
    } catch {
      observe?.({ kind, outcome: 'failed' });
    }
  }
  return {
    async paid(orderId) {
      const id = BigInt(orderId);
      await post(
        'order-kinesis',
        producer && environment.orderProducerAppId && environment.orderProducerAppKey
          ? producer
          : null,
        {
          'ar-app-id': environment.orderProducerAppId ?? '',
          'ar-app-key': environment.orderProducerAppKey ?? '',
        },
        { payload: id },
      );
      await post('order-engagement', engagement, {}, { order_id: id });
    },
  };
}
