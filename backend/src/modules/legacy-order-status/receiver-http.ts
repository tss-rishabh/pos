import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { stringifyNumericJson } from '../upstream.js';
import type { WholeOrderStatusOptions } from './options.js';
export const vendorResponse = z
  .object({ responseCode: z.number().int().safe(), responseMessage: z.string().max(1000) })
  .passthrough();
export function statusReceiverHttp(options: WholeOrderStatusOptions, fetcher: typeof fetch) {
  return async function post(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    json: boolean,
  ) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers,
        body: stringifyNumericJson(body),
        redirect: 'error',
        signal: AbortSignal.timeout(options.WHOLE_ORDER_STATUS_HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new AppError(
        502,
        'STORE_STATUS_REMOTE_UNKNOWN',
        'The remote status outcome is unknown.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        502,
        'STORE_STATUS_REMOTE_UNKNOWN',
        'The remote status outcome is unknown.',
      );
    }
    if (!json) {
      await response.body?.cancel();
      return null;
    }
    try {
      return vendorResponse.parse(await boundedJson(response, 65536));
    } catch {
      throw new AppError(
        502,
        'STORE_STATUS_REMOTE_UNKNOWN',
        'The remote status response could not be verified.',
      );
    }
  };
}
