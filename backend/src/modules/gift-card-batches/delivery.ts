import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import type { GiftCardBatchDelivery } from './contracts.js';
import type { GiftCardBatchOptions } from './options.js';
import { maxGiftCardArchiveBytes } from './generation.js';

/** Source Netcore attachment contract. Unknown acknowledgment is never automatically called delivered/retried. */
export function createGiftCardBatchDelivery(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE'>,
  options: GiftCardBatchOptions,
  fetcher: typeof fetch = fetch,
): GiftCardBatchDelivery | undefined {
  if (
    config.DEMO_MODE ||
    !options.GIFT_CARD_BATCHES_ENABLED ||
    !options.NETCORE_EMAIL_URL ||
    !options.NETCORE_API_KEY
  )
    return undefined;
  const endpoint = new URL(options.NETCORE_EMAIL_URL);
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
    async send(attemptId, input, signal) {
      if (
        !z.uuid().safeParse(attemptId).success ||
        !/^[1-9]\d{0,18}$/.test(input.batchId) ||
        !z.email().safeParse(input.recipient).success ||
        input.archive.length < 1 ||
        input.archive.length > maxGiftCardArchiveBytes
      )
        return 'rejected';
      let response: Response | undefined;
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            api_key: options.NETCORE_API_KEY!,
            'Content-Type': 'application/json',
            'Idempotency-Key': attemptId,
            ...(input.requestId && /^[A-Za-z0-9._-]{1,128}$/.test(input.requestId)
              ? { 'X-Request-Id': input.requestId }
              : {}),
          },
          body: JSON.stringify({
            from: { email: 'connect@thesouledstore.com', name: 'The Souled Store' },
            subject: 'GC Card Data',
            content: [
              {
                type: 'html',
                value: `Please download the attached file for Collection: ${input.batchId}. Retrieve its access password from your signed-in Gift card batches page.`,
              },
            ],
            personalizations: [
              { to: [{ email: input.recipient, name: input.recipient.split('@')[0] }] },
            ],
            attachments: [{ content: input.archive.toString('base64'), name: 'GC_CARD_DATA.zip' }],
          }),
          signal: signal
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(options.GIFT_CARD_BATCH_DELIVERY_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(options.GIFT_CARD_BATCH_DELIVERY_TIMEOUT_MS),
        });
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        )
          return 'rejected';
        if (!response.ok) return 'uncertain';
        const result = await boundedJson(response, 64000);
        return z.object({ status: z.literal('success') }).safeParse(result).success
          ? 'accepted'
          : 'uncertain';
      } catch {
        return 'uncertain';
      } finally {
        try {
          await response?.body?.cancel();
        } catch {
          /* Response was already consumed; no provider data is logged. */
        }
      }
    },
  };
}
