import { Readable } from 'node:stream';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { safeApplicationDestination, type ApplicationLinkOptions } from './contracts.js';
import { sourceCustomerLinkBody } from './domain.js';

export interface CustomerApplicationProvider {
  destination(storeId: string): Promise<string>;
  accepts(destination: string): boolean;
  readonly fallback: string;
}
const unavailable = () =>
  new AppError(
    503,
    'CUSTOMER_APPLICATION_UNAVAILABLE',
    'The customer application link is temporarily unavailable.',
  );
/**
 * Legacy `UserToApp` provider call (core/views.py:3201-3212): POST
 * `{MAIN_SITE_API_V2}firebase-dynamic-link` `{link}`; `object.shortLink` or `POS_APP_REDIRECT`.
 * Security decision: a short link outside `POS_CUSTOMER_APP_ORIGINS` is replaced by the
 * fallback, so a provider response cannot become an open redirect.
 */
export function createCustomerApplicationProvider(
  options: ApplicationLinkOptions,
  fetcher: typeof fetch = fetch,
): CustomerApplicationProvider | undefined {
  if (!options.MAIN_SITE_API_V2) return undefined;
  const endpoint = new URL('firebase-dynamic-link', options.MAIN_SITE_API_V2.replace(/\/?$/, '/')),
    accepts = (value: string) =>
      safeApplicationDestination(value, options.POS_CUSTOMER_APP_ORIGINS);
  return {
    accepts,
    fallback: options.POS_APP_REDIRECT,
    async destination(storeId) {
      if (!/^[1-9]\d{0,9}$/.test(storeId) || BigInt(storeId) > 2147483647n) throw unavailable();
      try {
        const response = await fetcher(endpoint, {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sourceCustomerLinkBody(storeId)),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw unavailable();
        const parsed = z
          .object({
            object: z
              .object({ shortLink: z.string().max(2048).nullish() })
              .loose()
              .nullish(),
          })
          .loose()
          .parse(await boundedJson(response, 32768));
        const target = parsed.object?.shortLink || options.POS_APP_REDIRECT;
        return accepts(target) ? target : options.POS_APP_REDIRECT;
      } catch {
        throw unavailable();
      }
    },
  };
}

export interface StaffApplicationPackage {
  /** Legacy `MposDownloadLink`: `requests.get(APP_APK_URL)` passed through (core/views.py:2976-2982). */
  open(signal?: AbortSignal): Promise<{
    stream: Readable;
    contentType: string;
    contentLength: string | null;
  }>;
}
/** Streams the configured `APP_APK_URL` instead of buffering it as legacy did. */
export function createStaffApplicationPackage(
  options: ApplicationLinkOptions,
  fetcher: typeof fetch = fetch,
): StaffApplicationPackage | undefined {
  if (!options.APP_APK_URL) return undefined;
  const source = options.APP_APK_URL;
  return {
    async open(signal) {
      let response: Response;
      try {
        response = await fetcher(source, {
          method: 'GET',
          redirect: 'follow',
          credentials: 'omit',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(600000)])
            : AbortSignal.timeout(600000),
        });
      } catch {
        throw new AppError(
          503,
          'STAFF_PACKAGE_UNAVAILABLE',
          'The staff application download is temporarily unavailable.',
        );
      }
      if (
        !response.ok ||
        !response.body ||
        (response.url !== '' && !response.url.startsWith('https:'))
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new AppError(
          503,
          'STAFF_PACKAGE_UNAVAILABLE',
          'The staff application download is temporarily unavailable.',
        );
      }
      return {
        stream: Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        contentType:
          response.headers.get('content-type') || 'application/vnd.android.package-archive',
        contentLength: response.headers.get('content-length'),
      };
    },
  };
}
