import { AppError } from '../../domain/errors.js';
import type { GiftCardBatchDelivery } from './contracts.js';
import type { GiftCardBatchOptions } from './options.js';
import { maxGiftCardArchiveBytes } from './generation.js';
import { outboundAllowlistEnabled, outboundPermitted } from '../../outbound/allowlist.js';

/**
 * Legacy `Helpers.send_mail` → `send_netcore_email` (helpers/helpers.py:1434-1475): one Netcore
 * POST with the zip as `GC_CARD_DATA.zip`. Legacy swallows every failure (`raise_for_status`
 * then `.json()`, exceptions logged); `send` returns false instead of throwing.
 */
export function createGiftCardBatchDelivery(
  options: GiftCardBatchOptions,
  fetcher: typeof fetch = fetch,
): GiftCardBatchDelivery | undefined {
  if (!options.NETCORE_EMAIL_URL || !options.NETCORE_API_KEY) return undefined;
  const endpoint = new URL(options.NETCORE_EMAIL_URL),
    apiKey = options.NETCORE_API_KEY;
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new AppError(
      503,
      'GIFT_CARD_BATCH_DELIVERY_CONFIGURATION',
      'Configure an approved gift card email endpoint.',
    );
  return {
    async send(input, signal) {
      if (
        !input.recipient ||
        input.archive.length < 1 ||
        input.archive.length > maxGiftCardArchiveBytes
      )
        return false;
      // Allowlist guard (w25): a suppressed batch mail reports success; the archive stays in S3.
      if (
        outboundAllowlistEnabled() &&
        !(await outboundPermitted({
          channel: 'email',
          module: 'gift-card-batches',
          flow: 'gift-card-batch-mail',
          targets: [{ kind: 'email', value: input.recipient }],
        }))
      )
        return true;
      const timeout = AbortSignal.timeout(options.GIFT_CARD_BATCH_DELIVERY_TIMEOUT_MS);
      let response: Response | undefined;
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { api_key: apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: { email: 'connect@thesouledstore.com', name: 'The Souled Store' },
            subject: 'GC Card Data',
            content: [
              {
                type: 'html',
                value: `Please download the attached file for Collection: ${input.collectionId}`,
              },
            ],
            personalizations: [
              { to: [{ email: input.recipient, name: input.recipient.split('@')[0] }] },
            ],
            attachments: [{ content: input.archive.toString('base64'), name: 'GC_CARD_DATA.zip' }],
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) return false;
        await response.json();
        return true;
      } catch {
        return false;
      } finally {
        try {
          if (response && !response.bodyUsed) await response.body?.cancel();
        } catch {
          /* No provider data is logged. */
        }
      }
    },
  };
}
