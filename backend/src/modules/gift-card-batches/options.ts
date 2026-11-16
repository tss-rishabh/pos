import { z } from 'zod';
import { readPrivateS3Options } from '../administration/private-s3-client.js';

const optional = <T extends z.ZodType>(value: T) =>
  z.preprocess((input) => (input === '' ? undefined : input), value.optional());
const flag = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
const keyId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const keys = z
  .record(
    keyId,
    z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((value) => value.toLowerCase()),
  )
  .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 8);
const keyring = z
  .string()
  .max(16384)
  .transform((value, context) => {
    try {
      return keys.parse(JSON.parse(value) as unknown);
    } catch {
      context.addIssue({ code: 'custom', message: 'Configure the gift card encryption keyring.' });
      return z.NEVER;
    }
  });
const view = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  );
export function readGiftCardBatchOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...readPrivateS3Options(env),
    ...z
      .object({
        GIFT_CARD_BATCHES_ENABLED: flag,
        GC_SALTKEY: optional(z.string().min(1).max(4096)),
        GIFT_CARD_BATCH_ACTIVE_KEY_ID: optional(keyId),
        GIFT_CARD_BATCH_ENCRYPTION_KEYS: optional(keyring),
        GIFT_CARD_BATCH_WORKER_ENABLED: flag,
        GIFT_CARD_BATCH_WORKER_INTERVAL_MS: z.coerce
          .number()
          .int()
          .min(1000)
          .max(60000)
          .default(2000),
        GIFT_CARD_BATCH_WORKER_LEASE_MS: z.coerce
          .number()
          .int()
          .min(30000)
          .max(300000)
          .default(120000),
        GIFT_CARD_BATCH_WORKER_TIMEOUT_MS: z.coerce
          .number()
          .int()
          .min(10000)
          .max(120000)
          .default(60000),
        S3_GIFT_CARD_BATCH_FOLDER_PATH: optional(
          z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,169}$/)
            .refine((value) => !value.split('/').some((part) => part === '.' || part === '..')),
        ),
        NETCORE_EMAIL_URL: optional(z.url()),
        NETCORE_API_KEY: optional(z.string().min(1).max(4096)),
        GIFT_CARD_BATCH_DELIVERY_TIMEOUT_MS: z.coerce
          .number()
          .int()
          .min(1000)
          .max(15000)
          .default(10000),
        BQ_GIFT_CARD_BATCH_VIEW: optional(view),
        BQ_GIFT_CARD_BATCH_MATCH_UDF: optional(view),
        BQ_GIFT_CARD_BATCH_CONTRACT: optional(z.literal('pos-gift-card-batch-history-v1')),
      })
      .parse(env),
  };
}
export type GiftCardBatchOptions = ReturnType<typeof readGiftCardBatchOptions>;
