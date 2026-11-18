import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const flag = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
/**
 * Legacy settings read by the express/hyperlocal views and `order/tasks.py`
 * (`POSAdmin/settings.py:449-595`). Shared secrets are defined by the upstream senders and
 * services, so they are accepted at any non-empty length, as legacy accepts them.
 */
export function readFulfillmentOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      /** `settings.py:507-508`: inbound new-order notify webhook (`APPID`/`APPKEY` headers). */
      APP_ID: optional(z.string().min(1).max(512)),
      APP_KEY: optional(z.string().min(1).max(1024)),
      /** `settings.py:558`: courier ship webhook (`apikey` header). */
      EXPRESS_ORDER_API_KEY: optional(z.string().min(1).max(1024)),
      /** `settings.py:453-454`: pre-order concurrency sync (T4). */
      PREORDER_URL: optional(z.url()),
      PREORDER_INTERNAL_KEY: optional(z.string().min(1).max(1024)),
      /** `settings.py:570-571`: sync-repo status and RTO calls. */
      BACKEND_SYNC_API_BASE_URL: optional(z.url()),
      BACKEND_SYNC_REPO_API_KEY: optional(z.string().max(1024)),
      /** `settings.py:449,566-567`: warehouse conversion `express-to-warehouse-order`. */
      MAIN_API_V2_URL: optional(z.url()),
      API_V2_APP_ID: optional(z.string().max(512)),
      API_V2_APP_KEY: optional(z.string().max(1024)),
      /** `settings.py:450`: mailr host for the out-for-delivery mail. */
      MJML_HOST: optional(z.url()),
      /** `settings.py:510,515`: common Slack channel and its copy switch. */
      SLACK_URL: optional(z.url()),
      /** Legacy `int(env, 0)`: any non-zero integer turns the copy on. */
      COMMON_GROUP_ALERT_ON: z.preprocess(
        (value) =>
          typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) !== 0 : value,
        flag,
      ),
      HL_TIMED_OUT_REASON_ID: z.coerce.number().int().min(1).max(2_147_483_647).default(5),
      HL_REJECT_LOCK_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(300),
      HL_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(20),
      HL_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(3_600_000).default(100000),
      HL_EXPIRY_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).max(300000).default(60000),
      OFD_ORDER_STATUS_ID: z.coerce.number().int().min(1).max(2_147_483_647).default(26),
      VINC_ALLOCATED_STATUSES: z
        .string()
        .default('Allocated,Part Allocated')
        .transform((value) => value.split(',')),
    })
    .parse(env);
}
export type FulfillmentOptions = ReturnType<typeof readFulfillmentOptions>;
/** Constant-time shared-secret comparison; an unset expected secret never matches. */
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
  options: Pick<FulfillmentOptions, 'APP_ID' | 'APP_KEY'>,
  headers: Record<string, unknown>,
): void {
  const id = secretMatches(options.APP_ID, headers.appid),
    key = secretMatches(options.APP_KEY, headers.appkey);
  if (!id || !key)
    throw new AppError(401, 'SERVICE_AUTHENTICATION_REQUIRED', 'Authentication Failed');
}
