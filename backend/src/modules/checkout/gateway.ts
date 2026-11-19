import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import type { Payload } from './payloads.js';
import { stringifyNumericJson } from '../upstream.js';
import { tracedFetch } from '../../observability/context.js';

/**
 * Checkout integration settings. Legacy calls unpatched API-v2, so no upstream contract
 * (projection, refund allocation, consent, customer/membership context, gift-card or exchange
 * stock proof) is read or required any more.
 */
export interface CheckoutEnvironment {
  hs256?: string;
  hs512?: string;
  paymentOrderUrl?: string;
  postOrderBaseUrl?: string;
  pineBaseUrl?: string;
  returnRefundUrl?: string;
  returnSecret?: string;
  giftCardSalt?: string;
  giftCardExpiryDays?: number;
}
export function checkoutEnvironment(env: NodeJS.ProcessEnv = process.env): CheckoutEnvironment {
  const value = z
    .object({
      TSS_JWT_HS256_KEY: z.string().min(32).optional(),
      TSS_JWT_HS512_KEY: z.string().min(32).optional(),
      TSS_PAYMENT_ORDER_URL: z.url().optional(),
      TSS_POST_ORDER_BASE_URL: z.url().optional(),
      TSS_PINELABS_BASE_URL: z.url().optional(),
      TSS_RETURN_REFUND_URL: z.url().optional(),
      TSS_RETURN_SECRET: z.string().min(16).optional(),
      TSS_GIFT_CARD_SALT: z.string().min(16).optional(),
      DEFAULT_GC_EX_DAYS: z.coerce.number().int().min(1).max(36500).default(90),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
  return {
    hs256: value.TSS_JWT_HS256_KEY,
    hs512: value.TSS_JWT_HS512_KEY,
    paymentOrderUrl: value.TSS_PAYMENT_ORDER_URL,
    postOrderBaseUrl: value.TSS_POST_ORDER_BASE_URL,
    pineBaseUrl: value.TSS_PINELABS_BASE_URL,
    returnRefundUrl: value.TSS_RETURN_REFUND_URL,
    returnSecret: value.TSS_RETURN_SECRET,
    giftCardSalt: value.TSS_GIFT_CARD_SALT,
    giftCardExpiryDays: value.DEFAULT_GC_EX_DAYS,
  };
}
export class CheckoutGatewayError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly uncertain: boolean,
    status = 502,
    /** API-v2 `is_pin_required` on a rejected gift-voucher apply. */
    public readonly pinRequired = false,
  ) {
    super(status, code, message);
  }
}
export interface CheckoutGateway {
  assertApiReady?(): void;
  api(path: string, payload: Payload, token?: string): Promise<unknown>;
  /** Payment-microservice confirmation (`AjaxOrderView.orders`, order/views.py:2881-2897). */
  confirm(payload: Payload, token: string): Promise<unknown>;
  exchangeReasons(categoryId: string): Promise<unknown>;
}
/**
 * API-v2 transport. Legacy sends only `Content-Type: application/json` and the raw JWT in
 * `Authorization` (no `Bearer`), with `requests.post(url, json=payload, headers=headers)`
 * (order/views.py:2850-2879). `pos/order` and the payment confirmation have no client timeout
 * in legacy; other calls keep an 8 s bound so a stuck read does not hold a cashier request.
 */
export function checkoutGateway(
  config: Config,
  environment: CheckoutEnvironment,
  fetcher: typeof fetch = tracedFetch,
): CheckoutGateway {
  function target(url: string | undefined) {
    if (!url)
      throw new AppError(
        503,
        'CHECKOUT_DEPENDENCY_UNAVAILABLE',
        'Checkout integration is not configured.',
      );
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      (parsed.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))
    )
      throw new AppError(
        503,
        'INVALID_CHECKOUT_CONFIGURATION',
        'Checkout integrations require HTTPS.',
      );
    return parsed;
  }
  async function request(
    url: string | undefined,
    payload: Payload,
    token: string | undefined,
    method: 'POST' | 'GET',
    timeoutMs: number | null,
  ): Promise<Response> {
    const parsed = target(url);
    try {
      return await fetcher(parsed, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: token } : {}),
        },
        body: method === 'POST' ? stringifyNumericJson(payload) : undefined,
        // Security decision: never forward the Authorization JWT across a redirect.
        redirect: 'error',
        ...(timeoutMs === null ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
      });
    } catch {
      throw new CheckoutGatewayError(
        'CHECKOUT_OUTCOME_UNCERTAIN',
        'The checkout service did not confirm this operation. Review its status before retrying.',
        true,
      );
    }
  }
  async function body(response: Response, uncertainOnFailure: boolean) {
    try {
      return await boundedJson(response);
    } catch {
      throw new CheckoutGatewayError(
        'CHECKOUT_OUTCOME_UNCERTAIN',
        'The checkout service returned an unreadable response. Review its status before retrying.',
        uncertainOnFailure,
      );
    }
  }
  async function send(
    url: string | undefined,
    payload: Payload,
    token?: string,
    method: 'POST' | 'GET' = 'POST',
    timeoutMs = 8000,
  ): Promise<unknown> {
    const response = await request(url, payload, token, method, timeoutMs);
    const value = await body(response, response.ok || response.status >= 500);
    if (!response.ok) {
      const error = z
        .object({
          title: z.string().max(500).optional(),
          message: z.string().max(500).optional(),
          is_pin_required: z.unknown().optional(),
        })
        .passthrough()
        .safeParse(value);
      throw new CheckoutGatewayError(
        'CHECKOUT_REJECTED',
        error.success
          ? error.data.title || error.data.message || 'Checkout could not complete this operation.'
          : 'Checkout could not complete this operation.',
        response.status >= 500,
        response.status >= 500 ? 502 : 422,
        error.success && Boolean(error.data.is_pin_required),
      );
    }
    return value;
  }
  function path(base: string | undefined, segment: string) {
    if (!base) return undefined;
    return new URL(segment, base.endsWith('/') ? base : base + '/').href;
  }
  return {
    assertApiReady: () => {
      target(config.TSS_API_BASE_URL);
    },
    async api(segment, payload, token) {
      if (segment !== 'pos/order')
        return send(
          path(config.TSS_API_BASE_URL, segment),
          payload,
          token,
          'POST',
          // call_pos_exchange_api (order/libs/calculations.py:419-423) uses timeout=30.
          segment === 'pos/exchange' ? 30000 : 8000,
        );
      // AjaxOrderView.order (order/views.py:2843-2879) and its caller (2751-2756): only HTTP 200
      // is success; any other status is "Something Went Wrong" and the cashier may retry.
      const response = await request(
        path(config.TSS_API_BASE_URL, segment),
        payload,
        token,
        'POST',
        null,
      );
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new CheckoutGatewayError(
          'ORDER_CREATE_FAILED',
          'Something Went Wrong. The order was not created; try again.',
          false,
          502,
        );
      }
      return body(response, true);
    },
    async confirm(payload, token) {
      // AjaxOrderView.orders (order/views.py:2881-2897); success is 200 or 201 (2810).
      const response = await request(environment.paymentOrderUrl, payload, token, 'POST', null);
      if (response.status !== 200 && response.status !== 201) {
        await response.body?.cancel().catch(() => undefined);
        throw new CheckoutGatewayError(
          'ORDER_CONFIRMATION_FAILED',
          'Something went wrong. The order was created but the payment service did not accept it.',
          false,
          502,
        );
      }
      await response.body?.cancel().catch(() => undefined);
      return {};
    },
    exchangeReasons: (categoryId) => {
      const url = path(environment.postOrderBaseUrl, 'list_of_reason/');
      if (!url)
        throw new AppError(
          503,
          'EXCHANGE_REASONS_UNAVAILABLE',
          'Exchange reasons are not configured.',
        );
      const parsed = new URL(url);
      parsed.searchParams.set('cat_id', categoryId);
      parsed.searchParams.set('reason_type', '2');
      return send(parsed.href, {}, undefined, 'GET');
    },
  };
}
