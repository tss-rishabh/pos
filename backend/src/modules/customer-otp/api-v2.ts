import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { currentRequestTrace, tracedFetch } from '../../observability/context.js';
import { stringifyNumericJson } from '../upstream.js';
import type { CustomerOtpApi, CustomerOtpApiReply } from './contracts.js';

const unavailable = () =>
  new AppError(503, 'CUSTOMER_OTP_UNAVAILABLE', 'Customer verification is not configured.');

/**
 * Legacy `AjaxSendOtpView.send_otp` / `AjaxVerifyOtpView.verify_otp` (`order/views.py:2549-2560`,
 * `:2584-2597`): `POST {MAIN_API_V2_URL}omnichannel-sendotp` with `{user_id}` and
 * `omnichannel-verifyotp` with `{user_id, otp}`, header `Content-Type: application/json` only
 * (no Authorization). The base URL is `TSS_API_BASE_URL`, as for every other API-v2 call.
 */
export function customerOtpApiV2(
  config: Pick<Config, 'TSS_API_BASE_URL' | 'NODE_ENV'>,
  fetcher: typeof fetch = tracedFetch,
): CustomerOtpApi {
  function base() {
    const raw = config.TSS_API_BASE_URL;
    if (!raw) throw unavailable();
    const parsed = new URL(raw);
    if (
      parsed.username ||
      parsed.password ||
      (parsed.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))
    )
      throw unavailable();
    return raw.endsWith('/') ? raw : raw + '/';
  }
  async function post(segment: string, payload: Record<string, unknown>) {
    const url = new URL(segment, base()),
      trace = currentRequestTrace();
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(trace ? { 'X-Request-ID': trace.requestId } : {}),
        },
        body: stringifyNumericJson(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return null;
    }
    let body: unknown = null;
    try {
      body = await boundedJson(response, 64_000);
    } catch {
      // Legacy verify only inspects the status code of a non-200 answer.
      if (response.status === 200) return null;
    }
    return { status: response.status, body } satisfies CustomerOtpApiReply;
  }
  return {
    assertReady: () => void base(),
    sendOtp: (userId) => post('omnichannel-sendotp', { user_id: userId }),
    verifyOtp: (userId, otp) => post('omnichannel-verifyotp', { user_id: userId, otp }),
  };
}
