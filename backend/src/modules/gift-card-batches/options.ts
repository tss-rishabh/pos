import { z } from 'zod';
import { readPrivateS3Options } from '../administration/private-s3-client.js';

const optional = <T extends z.ZodType>(value: T) =>
  z.preprocess((input) => (input === '' ? undefined : input), value.optional());

/**
 * Legacy settings used by `generate_and_upload_gift_card` (core/tasks.py:208-223):
 * `GC_SALTKEY` (Hashids salt), the storage bucket (helpers/storage.py) and Netcore
 * (`NETCORE_EMAIL_URL`, `NETCORE_API_KEY`, helpers/helpers.py:1434-1459).
 */
export function readGiftCardBatchOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...readPrivateS3Options(env),
    ...z
      .object({
        GC_SALTKEY: optional(z.string().min(1).max(4096)),
        NETCORE_EMAIL_URL: optional(z.url()),
        NETCORE_API_KEY: optional(z.string().min(1).max(4096)),
        GIFT_CARD_BATCH_DELIVERY_TIMEOUT_MS: z.coerce
          .number()
          .int()
          .min(1000)
          .max(60000)
          .default(30000),
      })
      .parse(env),
  };
}
export type GiftCardBatchOptions = ReturnType<typeof readGiftCardBatchOptions>;
