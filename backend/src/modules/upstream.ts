import type { Config } from '../config.js';
import { AppError, unavailable } from '../domain/errors.js';
import { boundedJson } from '../domain/http-json.js';
import { tracedFetch } from '../observability/context.js';

export interface CartContext {
  storeId: number | bigint;
  tabId: number;
  endUser: boolean;
}
type Payload = Record<string, unknown>;
const scope = (c: CartContext) => ({
  is_pos: true,
  store_id: c.storeId,
  ...(!c.endUser ? { tab_id: c.tabId } : {}),
});
/** Wire payloads preserve the legacy API contract; no checkout math is duplicated. */
export function addCartPayload(c: CartContext, barcode: string, customData: Payload | null = null) {
  return { ...scope(c), barcode, auto_add_to_cart: 1, custom_data: customData };
}
export function setCartPayload(c: CartContext, productId: number | bigint, quantity: number) {
  return {
    ...scope(c),
    payload: { operation: 'set', type: 'products', data: { prod_id: productId, quantity } },
  };
}
export function deleteCartPayload(
  c: CartContext,
  productId: number | bigint,
  giftVoucherId?: number | bigint,
) {
  return {
    ...scope(c),
    payload: {
      operation: 'delete',
      type: giftVoucherId ? 'giftvouchers' : 'products',
      data: giftVoucherId ? { prod_id: productId, gv_id: giftVoucherId } : { prod_id: productId },
    },
  };
}
export function validatePayload(c: CartContext, customData: Payload | null = null) {
  return { ...scope(c), custom_data: customData };
}
export function processPayload(c: CartContext, cart: Payload, customData: Payload | null = null) {
  return { ...cart, ...scope(c), custom_data: customData };
}

export function upstreamService(config: Config) {
  async function post(path: string, token: string, payload: Payload): Promise<unknown> {
    if (!config.TSS_API_BASE_URL) return unavailable('Checkout API');
    const base = new URL(
      config.TSS_API_BASE_URL.endsWith('/')
        ? config.TSS_API_BASE_URL
        : config.TSS_API_BASE_URL + '/',
    );
    if (config.NODE_ENV === 'production' && base.protocol !== 'https:')
      throw new AppError(503, 'INVALID_DEPENDENCY', 'Checkout API requires HTTPS.');
    let response: Response;
    try {
      response = await tracedFetch(new URL(path, base), {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: stringifyNumericJson(payload),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
    } catch {
      throw new AppError(
        502,
        'CHECKOUT_UNAVAILABLE',
        'Checkout service did not respond. Check order status before retrying a payment.',
      );
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 2_000_000)
      throw new AppError(502, 'INVALID_UPSTREAM_RESPONSE', 'Checkout response is too large.');
    let body: unknown;
    try {
      body = await boundedJson(response);
    } catch {
      throw new AppError(
        502,
        'INVALID_UPSTREAM_RESPONSE',
        'Checkout returned an invalid response.',
      );
    }
    if (!response.ok)
      throw new AppError(502, 'CHECKOUT_REJECTED', 'Checkout service rejected the operation.');
    return body;
  }
  return {
    add: (c: CartContext, token: string, barcode: string, customData?: Payload) =>
      post('pos/product', token, addCartPayload(c, barcode, customData)),
    set: (c: CartContext, token: string, productId: number | bigint, quantity: number) =>
      post(
        config.TSS_API_MIGRATION_V2 ? 'cart' : 'pos/cart',
        token,
        setCartPayload(c, productId, quantity),
      ),
    remove: (
      c: CartContext,
      token: string,
      productId: number | bigint,
      giftVoucherId?: number | bigint,
    ) =>
      post(
        config.TSS_API_MIGRATION_V2 ? 'cart' : 'pos/cart',
        token,
        deleteCartPayload(c, productId, giftVoucherId),
      ),
    validate: (c: CartContext, token: string) =>
      post('validatecheckout', token, validatePayload(c)),
    process: (c: CartContext, token: string, cart: Payload) =>
      post('processorder', token, processPayload(c, cart)),
  };
}

/** Node LTS emits integer JSON tokens without rounding identifiers through a double. */
export function stringifyNumericJson(value: unknown): string {
  const runtime = JSON as unknown as { rawJSON?: (source: string) => unknown };
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'bigint') return item;
    if (!runtime.rawJSON)
      throw new AppError(
        503,
        'UNSUPPORTED_NODE_RUNTIME',
        'Checkout requires the configured Node LTS runtime.',
      );
    return runtime.rawJSON(item.toString());
  });
}
