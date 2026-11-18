import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export function readFulfillmentOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      APP_ID: optional(z.string().min(1).max(128)),
      APP_KEY: optional(z.string().min(16).max(512)),
      EXPRESS_ORDER_API_KEY: optional(z.string().min(16).max(512)),
      PREORDER_URL: optional(z.url()),
      PREORDER_INTERNAL_KEY: optional(z.string().min(16).max(1024)),
      BACKEND_SYNC_API_BASE_URL: optional(z.url()),
      BACKEND_SYNC_REPO_API_KEY: optional(z.string().min(16).max(1024)),
      API_V2_APP_ID: optional(z.string().min(1).max(128)),
      API_V2_APP_KEY: optional(z.string().min(16).max(1024)),
      MJML_HOST: optional(z.url()),
      SLACK_URL: optional(z.url()),
      COMMON_GROUP_ALERT_ON: z.preprocess(
        (value) =>
          value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
        z.boolean(),
      ),
      HL_TIMED_OUT_REASON_ID: z.coerce.number().int().min(1).max(2_147_483_647).default(5),
      HL_EXPIRY_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).max(300000).default(60000),
      FULFILLMENT_WORKER_ENABLED: z.preprocess(
        (value) =>
          value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
        z.boolean(),
      ),
      FULFILLMENT_WORKER_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(1000),
      FULFILLMENT_MAINTENANCE_INTERVAL_MS: z.coerce
        .number()
        .int()
        .min(5000)
        .max(300000)
        .default(30000),
      FULFILLMENT_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
      FULFILLMENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
      VINC_ALLOCATED_STATUSES: z
        .string()
        .default('Allocated,Part Allocated')
        .transform((value) =>
          value
            .split(',')
            .map((status) => status.trim())
            .filter(Boolean),
        )
        .refine(
          (value) => value.length > 0 && value.length <= 20,
          'Configure at least one allocated warehouse status.',
        ),
    })
    .parse(env);
}
export type FulfillmentOptions = ReturnType<typeof readFulfillmentOptions>;
export function secretMatches(expected: string | undefined, provided: unknown): boolean {
  const left = createHash('sha256')
    .update(expected || 'missing-configured-key')
    .digest();
  const right = createHash('sha256')
    .update(typeof provided === 'string' ? provided : 'missing-request-key')
    .digest();
  return timingSafeEqual(left, right) && Boolean(expected) && typeof provided === 'string';
}
export function verifyWebhookCredentials(
  options: FulfillmentOptions,
  headers: Record<string, unknown>,
): void {
  const id = secretMatches(options.APP_ID, headers.appid),
    key = secretMatches(options.APP_KEY, headers.appkey);
  if (!id || !key)
    throw new AppError(401, 'SERVICE_AUTHENTICATION_REQUIRED', 'Authentication Failed');
}
