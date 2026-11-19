import type { Config } from '../../config.js';
import { boundedText } from '../../domain/http-json.js';
import { issueCustomerToken } from '../checkout/crypto.js';
import type { LegacyFulfillmentEnvironment } from './options.js';
import { pythonJsonDumps } from './python-text.js';
import { tracedFetch } from '../../observability/context.js';
import {
  outboundAllowlistEnabled,
  outboundPermitted,
  type OutboundAttempt,
} from '../../outbound/allowlist.js';

/** Outcome of one legacy `requests.post`. `status` 0 = no response (network error/timeout). */
export interface GatewayResponse {
  status: number;
  body: unknown;
  text: string;
}
export interface SlackDestination {
  url: string;
}
export interface CustomerTokenSubject {
  id: string;
  twoFactor: boolean;
}

/**
 * The HTTP calls legacy hyperlocal views make (`helpers/helpers.py`):
 * create_borzo_order `:836`, hl_order_cancel_refund `:852`, create_od_ticket `:891`,
 * place_online_order `:986`, refund_hl_charges_split `:1987`, push_order_kinesis `:505`,
 * slack_text_notification `:1093`, and `core/tasks.py:170` new_order_create_communication.
 * Each is one fire-once request with the legacy URL, headers and body. Tests replace `fetcher`.
 */
export interface HyperlocalGateway {
  createBorzoOrder(orderId: string, storeId: string): Promise<GatewayResponse>;
  cancelRefund(input: {
    customer: CustomerTokenSubject;
    orderId: string;
    reason: string;
    platform: string;
    /** Split orders: one `cancel-hl-order-items` request per HL product; legacy returns the last. */
    splitProductIds: readonly string[] | null;
  }): Promise<GatewayResponse | null>;
  placeOnlineOrder(
    customer: CustomerTokenSubject,
    orderId: string,
    split: boolean,
  ): Promise<GatewayResponse>;
  refundHlChargesSplit(orderId: string): Promise<GatewayResponse>;
  createOdTicket(input: {
    orderId: string;
    name: string;
    subject: string;
    description: string;
  }): Promise<GatewayResponse>;
  pushOrderKinesis(orderId: string): Promise<GatewayResponse>;
  slack(destination: SlackDestination, message: string): Promise<GatewayResponse>;
  newOrderCommunication(orderId: string): Promise<GatewayResponse>;
  /** Legacy `SLACK_URL` (common channel). */
  readonly commonSlackUrl: string | undefined;
  readonly commonAlertOn: boolean;
}

const local = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
/** The base must be https (plain http only to loopback outside production). */
function endpoint(raw: string | undefined, path: string, config: Pick<Config, 'NODE_ENV'>) {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw + path);
  } catch {
    return null;
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && local(url) && config.NODE_ENV !== 'production'))
  )
    return null;
  return url;
}
/** Slack posts only to Slack webhooks (store-configured URLs must not become an SSRF vector). */
export function slackEndpoint(raw: string | null | undefined, config: Pick<Config, 'NODE_ENV'>) {
  const url = endpoint(raw || undefined, '', config);
  if (!url) return null;
  if (url.hostname !== 'hooks.slack.com' && !(local(url) && config.NODE_ENV !== 'production'))
    return null;
  return url;
}

export function hyperlocalGateway(
  config: Pick<Config, 'NODE_ENV'>,
  options: LegacyFulfillmentEnvironment,
  fetcher: typeof fetch = tracedFetch,
  clock: () => number = Date.now,
): HyperlocalGateway {
  async function post(
    url: URL | null,
    body: string,
    headers: Record<string, string> = {},
    timeoutMs = options.LEGACY_DELIVERY_HTTP_TIMEOUT_MS,
  ): Promise<GatewayResponse> {
    if (!url) return { status: 0, body: null, text: '' };
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      let text = '';
      let parsed: unknown = null;
      try {
        text = await boundedText(response, 262144);
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed, text };
    } catch {
      return { status: 0, body: null, text: '' };
    }
  }
  /** Legacy `Helpers.create_token(user_id)` (JWT, HS512 for 2FA users). Expiry bounded to 1 h. */
  function token(customer: CustomerTokenSubject): string | null {
    try {
      return issueCustomerToken(
        {
          id: customer.id,
          email: '',
          firstName: '',
          lastName: '',
          telephone: '',
          twoFactor: customer.twoFactor,
          active: true,
          exclusive: false,
        },
        { hs256: options.TSS_JWT_HS256_KEY, hs512: options.TSS_JWT_HS512_KEY },
        clock(),
      );
    } catch {
      return null;
    }
  }
  const api = (path: string) => endpoint(options.MAIN_API_V2_URL, path, config);
  /**
   * Allowlist guard (w25). A suppressed message is not posted and answers HTTP 200, as an
   * accepted one does, so the hyperlocal flow carries on.
   */
  async function suppressed(url: URL | null, attempt: Omit<OutboundAttempt, 'module'>) {
    return (
      url !== null &&
      outboundAllowlistEnabled() &&
      !(await outboundPermitted({ ...attempt, module: 'legacy-fulfillment' }))
    );
  }
  const accepted: GatewayResponse = { status: 200, body: null, text: '' };
  return {
    commonSlackUrl: options.SLACK_URL,
    commonAlertOn: options.COMMON_GROUP_ALERT_ON,
    createBorzoOrder(orderId, storeId) {
      if (!options.TSS_OBERVER_APP_ID || !options.TSS_OBERVER_APP_KEY)
        return Promise.resolve({ status: 0, body: null, text: '' });
      return post(
        endpoint(options.TSS_OBERVER_URL, 'borzo-order-create', config),
        pythonJsonDumps({ order_id: orderId, store_id: storeId }),
        { app_id: options.TSS_OBERVER_APP_ID, app_key: options.TSS_OBERVER_APP_KEY },
      );
    },
    async cancelRefund({ customer, orderId, reason, platform, splitProductIds }) {
      const payload: Record<string, unknown> = {
        user_id: Number(customer.id),
        order_id: orderId,
        reason,
        platform,
        comment: reason,
      };
      if (!splitProductIds) return post(api('cancel-hl-order'), pythonJsonDumps(payload));
      const authorization = token(customer);
      let last: GatewayResponse | null = null;
      for (const productId of splitProductIds) {
        Object.assign(payload, { refund_mode: 1, prod_id: Number(productId) });
        last = authorization
          ? await post(api('cancel-hl-order-items'), pythonJsonDumps(payload), {
              Authorization: authorization,
            })
          : { status: 0, body: null, text: '' };
      }
      return last;
    },
    placeOnlineOrder(customer, orderId, split) {
      const authorization = token(customer);
      if (!authorization) return Promise.resolve({ status: 0, body: null, text: '' });
      return post(
        api(split ? 'hl-online-order-line' : 'hl-online-order'),
        pythonJsonDumps({ order_id: orderId }),
        { Authorization: authorization },
      );
    },
    refundHlChargesSplit(orderId) {
      return post(api('refund-hl-charges'), pythonJsonDumps({ order_id: orderId }));
    },
    async createOdTicket({ orderId, name, subject, description }) {
      const url = api('create-od-ticket');
      // API-v2 opens a OneDirect ticket that writes to the customer.
      if (
        await suppressed(url, {
          channel: 'onedirect',
          flow: 'onedirect-ticket',
          targets: [{ kind: 'order', id: orderId }],
        })
      )
        return { ...accepted };
      return post(
        url,
        pythonJsonDumps({
          order_id: orderId,
          platform: 'CONVERTED_ONLINE',
          name,
          subject,
          description,
        }),
      );
    },
    pushOrderKinesis(orderId) {
      if (!options.ORDER_PRODUCER_APP_ID || !options.ORDER_PRODUCER_APP_KEY)
        return Promise.resolve({ status: 0, body: null, text: '' });
      return post(
        endpoint(options.ORDER_PRODUCER_URL, '', config),
        pythonJsonDumps({ payload: orderId }),
        {
          'ar-app-id': options.ORDER_PRODUCER_APP_ID,
          'ar-app-key': options.ORDER_PRODUCER_APP_KEY,
        },
      );
    },
    async slack(destination, message) {
      const url = slackEndpoint(destination.url, config);
      if (
        await suppressed(url, {
          channel: 'slack',
          flow: 'hyperlocal-slack-alert',
          targets: [{ kind: 'slack-webhook', value: destination.url }],
        })
      )
        return { ...accepted };
      // Legacy posts Slack with timeout=5 (helpers.py:1117).
      return post(url, pythonJsonDumps({ text: message }), {}, 5000);
    },
    async newOrderCommunication(orderId) {
      const url = endpoint(options.MJML_HOST, 'api/v2/mailr/hyper_local/order_new/', config);
      if (
        await suppressed(url, {
          channel: 'api-v2',
          flow: 'hyperlocal-new-order-mail',
          targets: [{ kind: 'order', id: orderId }],
        })
      )
        return { ...accepted };
      return post(
        url,
        // Celery carries the API-v2 integer order id, so the body holds a JSON number.
        /^\d{1,19}$/.test(orderId)
          ? `{"order_id": ${orderId}}`
          : pythonJsonDumps({ order_id: orderId }),
      );
    },
  };
}
