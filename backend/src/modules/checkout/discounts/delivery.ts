import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { boundedJson } from '../../../domain/http-json.js';

/**
 * PG-discount emails, sent synchronously as legacy does:
 * - `tasks.send_pg_disc_otp(...)` is called inline from AjaxPGDiscOTPSend (order/views.py:4626).
 * - `tasks.pg_disc_otp_applied_email(...)` is called inline from AjaxOrderView
 *   (order/views.py:2772-2777).
 * Both go through `Helpers.send_custom_mail` -> `send_netcore_email` (helpers/helpers.py:1434-1504),
 * which logs and swallows delivery failures.
 */
export interface DiscountMail {
  to: string;
  /** Legacy passes no name, so Netcore receives the email local part. */
  subject: string;
  html: string;
}
export interface DiscountMailer {
  /** Resolves true when the provider accepted the message. Never throws for delivery failures. */
  send(mail: DiscountMail): Promise<boolean>;
}
export interface DiscountDeliveryEnvironment {
  url?: string;
  apiKey?: string;
  approvalSecret?: string;
}
export function discountDeliveryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DiscountDeliveryEnvironment {
  return {
    url: env.NETCORE_EMAIL_URL || undefined,
    apiKey: env.NETCORE_API_KEY || undefined,
    approvalSecret: env.DISCOUNT_APPROVAL_SECRET || undefined,
  };
}
export function assertDiscountDeliveryReady(
  environment: DiscountDeliveryEnvironment,
  code = true,
): void {
  if (
    !environment.url ||
    !environment.apiKey ||
    (code && (!environment.approvalSecret || environment.approvalSecret.length < 32))
  )
    throw new AppError(
      503,
      'DISCOUNT_DELIVERY_UNAVAILABLE',
      'Manager approval email delivery is not configured.',
    );
  if (!z.url().safeParse(environment.url).success)
    throw new AppError(
      503,
      'DISCOUNT_DELIVERY_UNAVAILABLE',
      'Manager approval email requires a configured HTTPS endpoint.',
    );
  const endpoint = new URL(environment.url);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new AppError(
      503,
      'DISCOUNT_DELIVERY_UNAVAILABLE',
      'Manager approval email requires a configured HTTPS endpoint.',
    );
}
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
/** Netcore transport with the legacy payload (helpers/helpers.py:1435-1440). */
export function netcoreDiscountMailer(
  environment: DiscountDeliveryEnvironment = discountDeliveryEnvironment(),
  fetcher: typeof fetch = fetch,
): DiscountMailer {
  return {
    async send(mail) {
      try {
        assertDiscountDeliveryReady(environment, false);
        const response = await fetcher(environment.url!, {
          method: 'POST',
          headers: { api_key: environment.apiKey!, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: { email: 'connect@thesouledstore.com', name: 'The Souled Store' },
            subject: mail.subject,
            content: [{ type: 'html', value: mail.html }],
            personalizations: [{ to: [{ email: mail.to, name: mail.to.split('@')[0] }] }],
          }),
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          return false;
        }
        await boundedJson(response, 64000);
        return true;
      } catch {
        // Legacy logs and continues (helpers/helpers.py:1457-1459). No address or body is logged.
        return false;
      }
    },
  };
}
/**
 * @deprecated The `pos_rewrite_discount_deliveries` outbox is deleted; emails are sent inline.
 * Kept only so `checkout/worker.ts` still compiles until its owner drops the dispatcher.
 */
export function discountOutboxDispatcher(..._unused: unknown[]) {
  return async function dispatch(_limit = 10) {
    return { delivered: 0, rejected: 0, uncertain: 0 };
  };
}
