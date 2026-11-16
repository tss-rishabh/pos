import { z } from 'zod';
import type { Config } from '../../../config.js';
import { AppError } from '../../../domain/errors.js';
import { boundedJson } from '../../../domain/http-json.js';
import { stringifyNumericJson } from '../../upstream.js';
import { legacyTrackingUrl } from '../domain.js';
import {
  providerObservation,
  providerRequest,
  providerResult,
  type ProviderKind,
  type ProviderObservation,
  type ProviderRequest,
  type ProviderResult,
} from './contracts.js';
import { providerRequestHash } from './domain.js';
import type { LegacyLifecycleOptions } from './options.js';

export interface LegacyProvider {
  ready(kind: ProviderKind, slackUrl?: string): boolean;
  send(
    input: ProviderRequest,
    token: string | undefined,
    requestId: string,
    signal?: AbortSignal,
    destination?: { slackUrl?: string },
  ): Promise<ProviderResult>;
  reconcile(
    input: ProviderRequest,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ProviderObservation>;
}
export function resultForRequest(kind: ProviderKind, value: unknown) {
  const result = providerResult.parse(value),
    valid =
      kind === 'borzo-create'
        ? ['courier-created', 'rejected'].includes(result.kind)
        : kind === 'online-convert'
          ? result.kind === 'online-created'
          : result.kind === 'acknowledged';
  if (!valid)
    throw new AppError(
      502,
      'PROVIDER_OUTCOME_UNKNOWN',
      'The external delivery result needs reconciliation.',
    );
  return result;
}
const missing = () =>
  new AppError(503, 'UPSTREAM_NOT_SENT', 'The local delivery integration is unavailable.');
function endpoint(
  raw: string | undefined,
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE'>,
  path = '',
) {
  if (!raw) throw missing();
  const url = new URL(path ? raw + path : raw),
    base = new URL(raw),
    local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    base.search ||
    base.hash ||
    (url.protocol !== 'https:' &&
      !(config.NODE_ENV !== 'production' && local && url.protocol === 'http:')) ||
    (config.DEMO_MODE && !local)
  )
    throw missing();
  return url;
}
export function providerHttpRequest(
  input: ProviderRequest,
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE'>,
  options: LegacyLifecycleOptions,
  token?: string,
  destination?: { slackUrl?: string },
) {
  const value = providerRequest.parse(input),
    headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': value.id,
    };
  let url: URL, payload: Record<string, unknown>;
  if (value.kind === 'borzo-create') {
    if (!options.TSS_OBERVER_APP_ID || !options.TSS_OBERVER_APP_KEY) throw missing();
    url = endpoint(options.TSS_OBERVER_URL, config, 'borzo-order-create');
    headers.app_id = options.TSS_OBERVER_APP_ID;
    headers.app_key = options.TSS_OBERVER_APP_KEY;
    payload = { order_id: value.orderId, store_id: value.storeId };
  } else if (value.kind === 'online-convert') {
    if (!token) throw missing();
    headers.Authorization = token;
    url = endpoint(
      options.MAIN_API_V2_URL,
      config,
      value.split ? 'hl-online-order-line' : 'hl-online-order',
    );
    payload = { order_id: value.orderId };
  } else if (value.kind === 'cancel-order' || value.kind === 'cancel-item') {
    url = endpoint(
      options.MAIN_API_V2_URL,
      config,
      value.kind === 'cancel-item' ? 'cancel-hl-order-items' : 'cancel-hl-order',
    );
    payload = {
      user_id: BigInt(value.customerId),
      order_id: value.orderId,
      reason: value.reason,
      platform: value.platform,
      comment: value.reason,
    };
    if (value.kind === 'cancel-item') {
      if (!token || !value.productId) throw missing();
      headers.Authorization = token;
      payload.refund_mode = 1;
      payload.prod_id = BigInt(value.productId);
    }
  } else if (value.kind === 'split-charge-refund') {
    url = endpoint(options.MAIN_API_V2_URL, config, 'refund-hl-charges');
    payload = { order_id: value.orderId };
  } else if (value.kind === 'order-producer') {
    if (!options.ORDER_PRODUCER_APP_ID || !options.ORDER_PRODUCER_APP_KEY) throw missing();
    url = endpoint(options.ORDER_PRODUCER_URL, config);
    headers['ar-app-id'] = options.ORDER_PRODUCER_APP_ID;
    headers['ar-app-key'] = options.ORDER_PRODUCER_APP_KEY;
    payload = { payload: value.orderId };
  } else if (value.kind === 'new-order-email') {
    if (!value.newOrderId) throw missing();
    url = endpoint(options.MJML_HOST, config, 'api/v2/mailr/hyper_local/order_new/');
    payload = { order_id: BigInt(value.newOrderId) };
  } else if (value.kind === 'support-ticket') {
    url = endpoint(options.MAIN_API_V2_URL, config, 'create-od-ticket');
    payload = {
      order_id: value.orderId,
      platform: 'CONVERTED_ONLINE',
      name: value.customerName,
      subject: value.subject,
      description: value.description,
    };
  } else {
    url = endpoint(destination?.slackUrl ?? options.SLACK_URL, config);
    if (
      url.hostname !== 'hooks.slack.com' &&
      !(config.NODE_ENV !== 'production' && ['127.0.0.1', 'localhost'].includes(url.hostname))
    )
      throw missing();
    payload = {
      text: value.description,
      parse: 'none',
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    };
  }
  return { url, headers, payload, body: stringifyNumericJson(payload) };
}
const sourceId = z
  .union([
    z.string().regex(/^[1-9]\d{0,19}$/),
    z.number().int().positive().safe().transform(String),
  ])
  .transform(String);
export function createLegacyProvider(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE'>,
  options: LegacyLifecycleOptions,
  fetcher: typeof fetch = fetch,
): LegacyProvider {
  const probe: ProviderRequest = {
    id: '00000000-0000-4000-a000-000000000001',
    commandId: '00000000-0000-4000-a000-000000000001',
    kind: 'borzo-create',
    orderId: '1',
    storeId: '1',
    customerId: '1',
    productId: '1',
    split: false,
    reason: '',
    platform: '',
    newOrderId: '1',
    subject: '',
    description: '',
    customerName: '',
    slackDestination: 'common',
    slackDestinationHash: null,
  };
  return {
    ready(kind, slackUrl) {
      try {
        providerHttpRequest({ ...probe, kind }, config, options, 'probe', { slackUrl });
        return true;
      } catch {
        return false;
      }
    },
    async send(input, token, requestId, signal, destination) {
      const request = providerHttpRequest(input, config, options, token, destination);
      if (/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) request.headers['X-Request-Id'] = requestId;
      let response: Response;
      try {
        response = await fetcher(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(options.LEGACY_DELIVERY_HTTP_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(options.LEGACY_DELIVERY_HTTP_TIMEOUT_MS),
        });
      } catch {
        throw new AppError(
          502,
          'PROVIDER_OUTCOME_UNKNOWN',
          'The external delivery result needs reconciliation.',
        );
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new AppError(
          502,
          'PROVIDER_OUTCOME_UNKNOWN',
          'The external delivery result needs reconciliation.',
        );
      }
      if (input.kind === 'borzo-create') {
        const result = z
          .object({
            is_successful: z.boolean(),
            order: z
              .object({
                order_id: sourceId,
                points: z
                  .array(z.object({ tracking_url: z.string().max(255).nullable().optional() }))
                  .min(2)
                  .max(100),
              })
              .optional(),
          })
          .parse(await boundedJson(response, 65536));
        if (!result.is_successful) return { kind: 'rejected', noSideEffects: true };
        if (!result.order)
          throw new AppError(
            502,
            'PROVIDER_OUTCOME_UNKNOWN',
            'The courier creation result needs reconciliation.',
          );
        return providerResult.parse({
          kind: 'courier-created',
          courierOrderId: result.order.order_id,
          sourceTracking: legacyTrackingUrl(result.order.points[0]!.tracking_url || null),
          destinationTracking: legacyTrackingUrl(result.order.points[1]!.tracking_url || null),
        });
      }
      if (input.kind === 'online-convert') {
        const result = z
          .object({
            order: sourceId,
            hl_charges_to_be_refunded: z.number().finite().nonnegative().optional(),
          })
          .parse(await boundedJson(response, 65536));
        return providerResult.parse({
          kind: 'online-created',
          newOrderId: result.order,
          hlCharges: result.hl_charges_to_be_refunded || 0,
        });
      }
      await response.body?.cancel();
      return { kind: 'acknowledged' };
    },
    async reconcile(input, requestId, signal) {
      if (
        !options.LEGACY_DELIVERY_RECONCILIATION_URL ||
        !options.LEGACY_DELIVERY_RECONCILIATION_KEY
      )
        return { status: 'unknown' };
      const url = endpoint(options.LEGACY_DELIVERY_RECONCILIATION_URL, config),
        requestHash = providerRequestHash(input);
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.LEGACY_DELIVERY_RECONCILIATION_KEY}`,
            'X-Request-Id': /^[A-Za-z0-9._-]{1,128}$/.test(requestId) ? requestId : input.commandId,
          },
          body: JSON.stringify({
            operationId: input.id,
            commandId: input.commandId,
            orderId: input.orderId,
            storeId: input.storeId,
            kind: input.kind,
            requestHash,
          }),
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(options.LEGACY_DELIVERY_HTTP_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(options.LEGACY_DELIVERY_HTTP_TIMEOUT_MS),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          return { status: 'unknown' };
        }
        const result = providerObservation.parse(await boundedJson(response, 65536));
        if (result.status !== 'unknown' && result.requestHash !== requestHash)
          return { status: 'unknown' };
        return result;
      } catch {
        return { status: 'unknown' };
      }
    },
  };
}
