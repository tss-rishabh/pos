import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { currentRequestTrace } from '../../observability/context.js';

/**
 * API-v2 voucher endpoints the legacy POS proxies (order/views.py:4518-4579). Legacy posts the
 * form strings `{user_id, gift_voucher_code, gc_pin, user_email}` and answers
 * `{status: <upstream HTTP status>, message: <upstream JSON>}`.
 */
export type VoucherUpstreamSegment = 'gift_voucher_check' | 'gift_voucher_to_tss_money';
export interface VoucherUpstreamPayload {
  user_id: string;
  gift_voucher_code: string;
  gc_pin: string;
  user_email: string;
}
export interface VoucherUpstreamReply {
  status: number;
  body: unknown;
}
export interface VoucherUpstream {
  /** Throws `VOUCHER_SERVICE_UNCERTAIN` when the outcome is unknown (transport/unreadable). */
  call(
    segment: VoucherUpstreamSegment,
    payload: VoucherUpstreamPayload,
    authorization: string,
  ): Promise<VoucherUpstreamReply>;
}
export const voucherServiceUncertain = () =>
  new AppError(
    502,
    'VOUCHER_SERVICE_UNCERTAIN',
    'The voucher service did not confirm this request. Check the customer balance before retrying.',
  );
export const voucherServiceUnavailable = () =>
  new AppError(503, 'VOUCHER_SERVICE_UNAVAILABLE', 'The voucher service is not configured.');

export function apiV2VoucherUpstream(
  config: Pick<Config, 'TSS_API_BASE_URL' | 'NODE_ENV'>,
  fetcher: typeof fetch = fetch,
): VoucherUpstream {
  return {
    async call(segment, payload, authorization) {
      const base = config.TSS_API_BASE_URL;
      if (!base) throw voucherServiceUnavailable();
      const url = new URL(segment, base.endsWith('/') ? base : base + '/');
      if (
        url.username ||
        url.password ||
        (url.protocol !== 'https:' &&
          !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)))
      )
        throw voucherServiceUnavailable();
      let response: Response;
      try {
        const trace = currentRequestTrace();
        response = await fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Legacy omits Authorization (security decision: send the customer token).
            Authorization: authorization,
            ...(trace ? { 'X-Request-ID': trace.requestId } : {}),
          },
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        throw voucherServiceUncertain();
      }
      try {
        return { status: response.status, body: await boundedJson(response, 64000) };
      } catch {
        if (response.ok || response.status >= 500) throw voucherServiceUncertain();
        return { status: response.status, body: null };
      }
    },
  };
}
