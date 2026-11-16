import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { Store, HyperlocalRejectionReason } from '../../db/legacy-schema.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import type { EffectDelivery, EffectDispatcher } from './outbox.js';
import type { FulfillmentOptions } from './options.js';
import { slackText } from './slack-text.js';

/** Python sends integer identifiers as JSON numbers; preserve all 64 bits on Node. */
function jsonInteger(value: string): unknown {
  if (!/^\d+$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n)
    throw new AppError(400, 'UPSTREAM_NOT_SENT', 'The external identifier is out of range.');
  const number = Number(value);
  if (Number.isSafeInteger(number)) return number;
  const json = JSON as typeof JSON & { rawJSON?: (input: string) => unknown };
  if (!json.rawJSON)
    throw new AppError(
      503,
      'UPSTREAM_NOT_SENT',
      'This operation requires the supported Node runtime.',
    );
  return json.rawJSON(value);
}

function safeBase(value: string | undefined, name: string, config: Config): URL {
  if (!value) return unavailable(name);
  const url = new URL(value.endsWith('/') ? value : value + '/');
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    !['http:', 'https:'].includes(url.protocol) ||
    (config.NODE_ENV === 'production' && !local && url.protocol !== 'https:')
  )
    throw new AppError(503, 'DEPENDENCY_UNAVAILABLE', `${name} requires an HTTPS endpoint.`);
  return url;
}
export function effectRequest(
  delivery: EffectDelivery,
  config: Config,
  options: FulfillmentOptions,
): { url: URL; headers: Record<string, string>; payload: Record<string, unknown> } | null {
  const p = delivery.payload;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': delivery.effectId,
  };
  if (delivery.kind === 'concurrency-sync') {
    if (!options.PREORDER_INTERNAL_KEY) return unavailable('Pre-order concurrency credentials');
    const payload = z
      .object({
        storeId: z.string().regex(/^\d+$/),
        pending: z.number().int(),
        accepted: z.number().int(),
      })
      .parse(p);
    if (payload.pending === 0 && payload.accepted === 0) return null;
    headers.Authorization = `Bearer ${options.PREORDER_INTERNAL_KEY}`;
    return {
      url: new URL(
        'express-delivery/concurrency-sync',
        safeBase(options.PREORDER_URL, 'Pre-order concurrency service', config),
      ),
      headers,
      payload: {
        storeId: jsonInteger(payload.storeId),
        ...(payload.pending ? { pending: payload.pending } : {}),
        ...(payload.accepted ? { accepted: payload.accepted } : {}),
      },
    };
  }
  if (delivery.kind === 'status-api' || delivery.kind === 'rto-api') {
    if (!options.BACKEND_SYNC_REPO_API_KEY) return unavailable('Fulfillment sync credentials');
    const payload = z
      .object({
        orderId: z.string().regex(/^\d+$/),
        hasProductIds: z.array(z.string().regex(/^\d+$/)).min(1),
        status: z.enum(['PACK', 'SHIP']).optional(),
      })
      .parse(p);
    headers['x-api-key'] = options.BACKEND_SYNC_REPO_API_KEY;
    return {
      url: new URL(
        delivery.kind === 'rto-api' ? 'order/rto' : 'order/status',
        safeBase(options.BACKEND_SYNC_API_BASE_URL, 'Fulfillment sync service', config),
      ),
      headers,
      payload: {
        orderId: payload.orderId,
        has_product_ids: payload.hasProductIds,
        ...(delivery.kind === 'status-api' ? { platform: payload.status } : {}),
      },
    };
  }
  if (delivery.kind === 'rejection-api') {
    if (!options.API_V2_APP_ID || !options.API_V2_APP_KEY)
      return unavailable('Warehouse conversion credentials');
    const payload = z
      .object({
        orderId: z.string().regex(/^\d+$/),
        hasProductIds: z.array(z.string().regex(/^\d+$/)).min(1),
      })
      .parse(p);
    headers.Ar_app_id = options.API_V2_APP_ID;
    headers.Ar_app_key = options.API_V2_APP_KEY;
    return {
      url: new URL(
        'express-to-warehouse-order',
        safeBase(config.TSS_API_BASE_URL, 'Warehouse conversion service', config),
      ),
      headers,
      payload: {
        order_id: jsonInteger(payload.orderId),
        has_product_ids: payload.hasProductIds.map(jsonInteger),
      },
    };
  }
  if (delivery.kind === 'out-for-delivery-api') {
    const payload = z
      .object({ orderId: z.string().regex(/^\d+$/), awb: z.string().max(255) })
      .parse(p);
    return {
      url: new URL(
        'api/v2/mailr/express-order/out-for-delivery/',
        safeBase(options.MJML_HOST, 'Out-for-delivery notification service', config),
      ),
      headers,
      payload: { order_id: payload.orderId, awb: payload.awb },
    };
  }
  return null;
}
export function integrationDispatcher(
  config: Config,
  db: Databases,
  options: FulfillmentOptions,
): EffectDispatcher {
  async function post(url: URL, headers: Record<string, string>, payload: Record<string, unknown>) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new AppError(
        502,
        'FULFILLMENT_DELIVERY_UNKNOWN',
        'The external fulfillment result is unknown.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        502,
        'FULFILLMENT_DELIVERY_UNKNOWN',
        'The external fulfillment result requires reconciliation.',
      );
    }
    return response;
  }
  return async (delivery): Promise<Record<string, string | number | boolean>> => {
    if (delivery.kind === 'store-notification') {
      const [store] = await db
        .get('primary')
        .select({ name: Store.store_name, url: Store.slack_group_url })
        .from(Store)
        .where(eq(Store.id, BigInt(delivery.storeId)))
        .limit(1);
      const parsed = z
        .object({
          action: z.enum([
            'ACCEPT',
            'REJECT',
            'PACK',
            'SHIP',
            'RTO',
            'NEW_ORDER',
            'AUTO_PACK',
            'WAIT_TIMEOUT',
            'WAIT_REJECTION',
            'ALLOCATION_READY',
            'TIMEOUT_CONVERSION',
            'DAY_CLOSE_PENDING',
          ]),
          productIds: z.array(z.string()).optional(),
          commonChannel: z.boolean().optional(),
          closeDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          status: z.string().max(32).optional(),
        })
        .parse(delivery.payload);
      const name = slackText(store?.name || `Store ${delivery.storeId}`),
        skus = `[${(parsed.productIds || []).join(', ')}]`;
      let text = '';
      if (parsed.action === 'ACCEPT')
        text = `✅ Hyperlocal Order ID: ${delivery.orderId} Accepted at ${name}`;
      if (parsed.action === 'PACK')
        text = `📦 Hyperlocal Order ID: ${delivery.orderId} Packed at ${name} | SKUs: ${skus}`;
      if (parsed.action === 'SHIP')
        text = `🚚 Hyperlocal Order ID: ${delivery.orderId} Shipped from ${name} | SKUs: ${skus}`;
      if (parsed.action === 'RTO')
        text = `🔄 Hyperlocal Order ID: ${delivery.orderId} marked as RTO at ${name} | SKUs: ${skus}`;
      if (parsed.action === 'NEW_ORDER')
        text = `🛵 Order Id: ${delivery.orderId}, Hyperlocal Order to ${name}`;
      if (parsed.action === 'DAY_CLOSE_PENDING') {
        if (!parsed.closeDate)
          throw new AppError(503, 'UPSTREAM_NOT_SENT', 'The pending-close date is unavailable.');
        const [year, month, day] = parsed.closeDate.split('-'),
          label =
            parsed.status === 'NOT_CLOSED'
              ? 'was never closed'
              : 'was closed but is no longer valid';
        text = `Day Close pending — ${name} — ${day}-${month}-${year} ${label}. The window has passed, so an OPM or above must now file it.`;
      }
      if (parsed.action === 'AUTO_PACK')
        text = `📦 Hyperlocal Order ID: ${delivery.orderId} auto-packed at ${name} — acceptance window expired | SKUs: ${skus}`;
      if (parsed.action === 'WAIT_TIMEOUT')
        text = `⏱️ Order wait time exceeded for ID: ${delivery.orderId} | Store: ${name} | SKUs: ${skus}`;
      if (parsed.action === 'WAIT_REJECTION')
        text = `❌ Order wait time exceeded for ID: ${delivery.orderId} | Store: ${name} | SKUs: ${skus}`;
      if (parsed.action === 'ALLOCATION_READY')
        text = `🔺 Order ID: ${delivery.orderId} | Store: ${name} | Order was Timed Out earlier — Vinculum has now allocated the items, proceeding with conversion to online order | SKUs: ${skus}`;
      if (parsed.action === 'TIMEOUT_CONVERSION') {
        const newOrder =
          delivery.priorResults.findLast((result) => result.newOrderId)?.newOrderId || 'N/A';
        text = `❌ Hyperlocal Order ID: ${delivery.orderId} Timed Out — Converted to online order | New Order ID: ${newOrder} | SKUs: ${skus}`;
      }
      if (parsed.action === 'REJECT') {
        const raw = delivery.payload.rejectionReasonId;
        const reasonId = typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
        const [reason] = await db
          .get('primary')
          .select({ reason: HyperlocalRejectionReason.reason })
          .from(HyperlocalRejectionReason)
          .where(eq(HyperlocalRejectionReason.id, reasonId))
          .limit(1);
        const newOrder =
          delivery.priorResults.find((result) => result.newOrderId)?.newOrderId || 'N/A';
        text = `❌ Hyperlocal Order ID: ${delivery.orderId} Rejected at ${name} — Converted to online order | New Order ID: ${newOrder} | Reason: ${slackText(reason?.reason || '')} | SKUs: ${skus}`;
      }
      const common = parsed.commonChannel === true;
      const target = store?.url || options.SLACK_URL;
      if (!common && (!target || target === options.SLACK_URL)) return { skipped: true };
      if (!target) return unavailable('Store notification channel');
      const urls = [
        target,
        ...(common &&
        options.COMMON_GROUP_ALERT_ON &&
        options.SLACK_URL &&
        target !== options.SLACK_URL
          ? [options.SLACK_URL]
          : []),
      ];
      for (const value of urls) {
        safeBase(value, 'Store notification channel', config);
        const url = new URL(value);
        if (
          url.hostname !== 'hooks.slack.com' ||
          url.protocol !== 'https:' ||
          url.search ||
          url.hash
        )
          throw new AppError(
            503,
            'DEPENDENCY_UNAVAILABLE',
            'Store notification channel must use the Slack webhook host.',
          );
        const response = await post(
          url,
          { 'Content-Type': 'application/json' },
          { text, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false },
        );
        await response.body?.cancel();
      }
      return { sent: true };
    }
    const request = effectRequest(delivery, config, options);
    if (!request) return { skipped: true };
    const response = await post(request.url, request.headers, request.payload);
    if (delivery.kind === 'rejection-api') {
      const result = z
        .object({ order: z.union([z.string(), z.number()]).optional() })
        .parse(await boundedJson(response));
      return { newOrderId: result.order === undefined ? 'N/A' : String(result.order) };
    }
    await response.body?.cancel();
    return { acknowledged: true };
  };
}
