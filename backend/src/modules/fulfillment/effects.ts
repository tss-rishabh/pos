import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { HasProduct, Store } from '../../db/legacy-schema.js';
import { boundedJson } from '../../domain/http-json.js';
import { currentRequestTrace, tracedFetch } from '../../observability/context.js';
import { syncRepoStatusApi, type CallStatusApi } from '../legacy-order-status/transport.js';
import type { FulfillmentOptions } from './options.js';
import { slackText } from './slack-text.js';

/** Identifier-only structured event. Never carries message text, payloads or responses. */
export interface FulfillmentEvent {
  eventId: string;
  resource: string;
  outcome: string;
  storeId?: string;
  orderId?: string;
  count?: number;
  httpStatus?: number;
}
export type FulfillmentLogger = (level: 'info' | 'warn' | 'error', event: FulfillmentEvent) => void;
export function fulfillmentLogger(
  write: (
    level: 'info' | 'warn' | 'error',
    event: Record<string, unknown>,
    message: string,
  ) => void,
): FulfillmentLogger {
  return (level, event) => {
    const trace = currentRequestTrace();
    write(
      level,
      {
        module: 'fulfillment',
        eventInstanceId: randomUUID(),
        requestId: trace?.requestId ?? null,
        userId: trace?.userId ?? null,
        ...event,
      },
      'Fulfillment side effect',
    );
  };
}

/** Python sends integer identifiers as JSON numbers; preserve all 64 bits on Node. */
function jsonInteger(value: string): unknown {
  const number = Number(value);
  if (Number.isSafeInteger(number)) return number;
  const json = JSON as typeof JSON & { rawJSON?: (input: string) => unknown };
  return json.rawJSON ? json.rawJSON(BigInt(value).toString()) : number;
}
/** Python `str(list_of_ints)`, e.g. `[12, None, 7]`. */
export function pythonIdList(values: readonly (string | null)[]): string {
  return `[${values.map((value) => (value === null ? 'None' : value)).join(', ')}]`;
}

export interface SlackTarget {
  /** Store whose channel is used when `slackUrl` is not given (legacy `store_id`). */
  storeId?: string;
  /** Explicit channel (legacy `slack_url`); `null` falls back like legacy `None`. */
  slackUrl?: string | null;
  sendToCommon?: boolean;
}
export interface FulfillmentEffectsDependencies {
  fetch?: typeof fetch;
  log?: FulfillmentLogger;
  callStatusApi?: CallStatusApi;
  /** Upper bound on in-flight fire-and-forget concurrency syncs (legacy daemon threads). */
  maxInFlight?: number;
}

/**
 * The legacy express side effects, called inline after the MySQL transaction commits, exactly
 * where legacy calls them (`order/views.py:4667-5250`, `order/tasks.py`). Every call is
 * at-most-once with the legacy timeout; failures are only logged, as legacy only logs them.
 */
export function fulfillmentEffects(
  db: Databases,
  options: FulfillmentOptions,
  dependencies: FulfillmentEffectsDependencies = {},
) {
  const fetcher = dependencies.fetch ?? tracedFetch,
    log = dependencies.log ?? (() => {}),
    maxInFlight = dependencies.maxInFlight ?? 16,
    inFlight = new Set<Promise<void>>();
  const callStatusApi =
    dependencies.callStatusApi ??
    syncRepoStatusApi(options, fetcher, (outcome, hyperlocal) =>
      log(outcome === 'sent' ? 'info' : 'warn', {
        eventId: 'fulfillment.sync-repo-status.' + outcome,
        resource: hyperlocal ? 'sync-repo-order-status' : 'sync-repo-store-order-status',
        outcome,
      }),
    );

  async function post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    return fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  async function store(storeId: string) {
    if (!/^\d+$/.test(storeId)) return undefined;
    const [row] = await db
      .get('primary')
      .select({ name: Store.store_name, slackUrl: Store.slack_group_url })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .limit(1);
    return row;
  }
  /** Rewrite hardening: only Slack incoming-webhook URLs receive alert text. */
  function slackUrlAllowed(value: string) {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.hostname === 'hooks.slack.com' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }
  async function postSlack(url: string | undefined | null, text: string) {
    if (!url || !slackUrlAllowed(url)) {
      log('warn', {
        eventId: 'fulfillment.slack.not-sent',
        resource: 'slack',
        outcome: 'invalid-channel',
      });
      return;
    }
    try {
      const response = await post(
        url,
        {},
        { text, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false },
        5000,
      );
      await response.body?.cancel();
      log('info', {
        eventId: 'fulfillment.slack.sent',
        resource: 'slack',
        outcome: 'sent',
        httpStatus: response.status,
      });
    } catch {
      log('error', { eventId: 'fulfillment.slack.failed', resource: 'slack', outcome: 'failed' });
    }
  }
  /** Legacy `Helpers.slack_text_notification` (`helpers/helpers.py:1093-1130`). */
  async function slack(message: string, target: SlackTarget = {}) {
    const sendToCommon = target.sendToCommon ?? true;
    let url: string | null | undefined = target.slackUrl;
    if (url === undefined || url === null) {
      url = options.SLACK_URL;
      if (target.storeId) {
        const own = (await store(target.storeId).catch(() => undefined))?.slackUrl;
        if (own) url = own;
      }
    }
    if (!sendToCommon && (!url || url === options.SLACK_URL)) {
      log('info', {
        eventId: 'fulfillment.slack.skipped',
        resource: 'slack',
        outcome: 'routine-no-store-channel',
      });
      return;
    }
    await postSlack(url, message);
    if (sendToCommon && options.COMMON_GROUP_ALERT_ON && url !== options.SLACK_URL)
      await postSlack(options.SLACK_URL, message);
  }
  /** Legacy `Helpers.express_concurrency_sync` (`helpers/helpers.py:1616-1670`), thread T4. */
  function concurrencySync(
    storeId: string | null,
    deltas: { pending?: number; accepted?: number },
  ) {
    const pending = deltas.pending ?? 0,
      accepted = deltas.accepted ?? 0;
    if (!storeId || storeId === '0' || (!pending && !accepted)) return;
    if (!options.PREORDER_URL || !options.PREORDER_INTERNAL_KEY) {
      log('warn', {
        eventId: 'fulfillment.concurrency-sync.skipped',
        resource: 'preorder-concurrency',
        outcome: 'unconfigured',
      });
      return;
    }
    if (inFlight.size >= maxInFlight) {
      log('error', {
        eventId: 'fulfillment.concurrency-sync.dropped',
        resource: 'preorder-concurrency',
        outcome: 'saturated',
        storeId,
      });
      return;
    }
    const url = options.PREORDER_URL.replace(/\/+$/, '') + '/express-delivery/concurrency-sync',
      key = options.PREORDER_INTERNAL_KEY;
    const task = (async () => {
      try {
        const response = await post(
          url,
          { Authorization: `Bearer ${key}` },
          {
            storeId: jsonInteger(storeId),
            ...(pending ? { pending } : {}),
            ...(accepted ? { accepted } : {}),
          },
          10000,
        );
        await response.body?.cancel();
        log(response.ok ? 'info' : 'error', {
          eventId: `fulfillment.concurrency-sync.${response.ok ? 'sent' : 'failed'}`,
          resource: 'preorder-concurrency',
          outcome: response.ok ? 'sent' : 'rejected',
          storeId,
          httpStatus: response.status,
        });
      } catch {
        log('error', {
          eventId: 'fulfillment.concurrency-sync.failed',
          resource: 'preorder-concurrency',
          outcome: 'failed',
          storeId,
        });
      }
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }
  async function skuIds(hasProductIds: readonly string[]): Promise<(string | null)[]> {
    if (!hasProductIds.length) return [];
    const rows = await db
      .get('primary')
      .select({ productId: HasProduct.product })
      .from(HasProduct)
      .where(inArray(HasProduct.id, hasProductIds.map(BigInt)))
      .orderBy(asc(HasProduct.id));
    return rows.map((row) => (row.productId === null ? null : String(row.productId)));
  }
  /**
   * Legacy `_call_order_rejection_api` (`order/views.py:4849-4905`) and the timeout twin
   * `_call_rejection_api` (`order/tasks.py:19-54`): POST `MAIN_API_V2_URL +
   * 'express-to-warehouse-order'`, then on success a Slack alert naming the new order.
   */
  async function rejectionApi(
    orderId: string,
    hasProductIds: readonly string[],
    context:
      | { kind: 'rejected'; reason: string; storeName: string; storeId: string }
      | { kind: 'timed-out'; storeId: string },
  ) {
    if (!options.MAIN_API_V2_URL) {
      log('warn', {
        eventId: 'fulfillment.warehouse-conversion.skipped',
        resource: 'warehouse-conversion',
        outcome: 'unconfigured',
        orderId,
      });
      return;
    }
    let response: Response;
    try {
      response = await post(
        options.MAIN_API_V2_URL + 'express-to-warehouse-order',
        { Ar_app_id: options.API_V2_APP_ID ?? '', Ar_app_key: options.API_V2_APP_KEY ?? '' },
        { order_id: jsonInteger(orderId), has_product_ids: hasProductIds.map(jsonInteger) },
        10000,
      );
    } catch {
      log('error', {
        eventId: 'fulfillment.warehouse-conversion.failed',
        resource: 'warehouse-conversion',
        outcome: 'failed',
        orderId,
      });
      return;
    }
    if (!response.ok) {
      await response.body?.cancel();
      log('error', {
        eventId: 'fulfillment.warehouse-conversion.rejected',
        resource: 'warehouse-conversion',
        outcome: 'rejected',
        orderId,
        httpStatus: response.status,
      });
      return;
    }
    let newOrderId = 'N/A';
    try {
      const body = z
        .object({ order: z.union([z.string(), z.number(), z.bigint()]).optional() })
        .loose()
        .safeParse(await boundedJson(response));
      if (body.success && body.data.order !== undefined) newOrderId = String(body.data.order);
    } catch {
      newOrderId = 'N/A';
    }
    log('info', {
      eventId: 'fulfillment.warehouse-conversion.sent',
      resource: 'warehouse-conversion',
      outcome: 'sent',
      orderId,
    });
    const skus = pythonIdList(await skuIds(hasProductIds));
    await slack(
      context.kind === 'rejected'
        ? `❌ Hyperlocal Order ID: ${orderId} Rejected at ${slackText(context.storeName)} — Converted to online order | New Order ID: ${slackText(newOrderId)} | Reason: ${slackText(context.reason)} | SKUs: ${skus}`
        : `❌ Hyperlocal Order ID: ${orderId} Timed Out — Converted to online order | New Order ID: ${slackText(newOrderId)} | SKUs: ${skus}`,
      { storeId: context.storeId },
    );
  }
  async function simplePost(
    resource: string,
    url: string | null,
    headers: Record<string, string>,
    body: unknown,
    orderId: string,
  ) {
    if (!url) {
      log('warn', {
        eventId: `fulfillment.${resource}.skipped`,
        resource,
        outcome: 'unconfigured',
        orderId,
      });
      return;
    }
    try {
      const response = await post(url, headers, body, 10000);
      await response.body?.cancel();
      log(response.ok ? 'info' : 'error', {
        eventId: `fulfillment.${resource}.${response.ok ? 'sent' : 'rejected'}`,
        resource,
        outcome: response.ok ? 'sent' : 'rejected',
        orderId,
        httpStatus: response.status,
      });
    } catch {
      log('error', {
        eventId: `fulfillment.${resource}.failed`,
        resource,
        outcome: 'failed',
        orderId,
      });
    }
  }
  return {
    slack,
    concurrencySync,
    rejectionApi,
    skuIds,
    store,
    callStatusApi,
    /** Legacy `Helpers.call_express_out_for_delivery_api` (`helpers/helpers.py:1194-1200`). */
    outForDelivery: (orderId: string, awb: string) =>
      simplePost(
        'out-for-delivery-mail',
        options.MJML_HOST
          ? options.MJML_HOST + 'api/v2/mailr/express-order/out-for-delivery/'
          : null,
        {},
        { order_id: orderId, awb },
        orderId,
      ),
    /** Legacy `_call_vinculum_rto_api` (`order/views.py:5169-5205`). */
    vinculumRto: (orderId: string, hasProductIds: readonly string[]) =>
      simplePost(
        'vinculum-rto',
        options.BACKEND_SYNC_API_BASE_URL
          ? options.BACKEND_SYNC_API_BASE_URL.replace(/\/+$/, '') + '/order/rto'
          : null,
        { 'x-api-key': options.BACKEND_SYNC_REPO_API_KEY ?? '' },
        { orderId, has_product_ids: hasProductIds.map(String) },
        orderId,
      ),
    /** Test and shutdown helper: waits for the fire-and-forget calls in flight. */
    async idle() {
      await Promise.allSettled([...inFlight]);
    },
  };
}
export type FulfillmentEffects = ReturnType<typeof fulfillmentEffects>;
