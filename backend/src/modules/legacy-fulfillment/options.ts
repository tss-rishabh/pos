import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
/** Python `int(ENV.get(name, fallback))` truthiness, as `POSAdmin/settings.py` reads these flags. */
const intFlag = (fallback: 0 | 1) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? fallback : value),
    z.coerce
      .number()
      .int()
      .transform((value) => value !== 0),
  );

/**
 * Hyperlocal (local-delivery) settings, with the legacy names and defaults of
 * `POSAdmin/settings.py:449-555`. Every external endpoint is optional: a missing one makes
 * that call fail the way a refused legacy request fails (logged, never retried).
 */
export function readLegacyFulfillmentOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      APP_ID: optional(z.string().min(1).max(128)),
      APP_KEY: optional(z.string().min(1).max(1024)),
      TSS_OBERVER_URL: optional(z.url()),
      TSS_OBERVER_APP_ID: optional(z.string().min(1).max(128)),
      TSS_OBERVER_APP_KEY: optional(z.string().min(1).max(1024)),
      MAIN_API_V2_URL: optional(z.url()),
      MJML_HOST: optional(z.url()),
      ORDER_PRODUCER_URL: optional(z.url()),
      ORDER_PRODUCER_APP_ID: optional(z.string().min(1).max(128)),
      ORDER_PRODUCER_APP_KEY: optional(z.string().min(1).max(1024)),
      SLACK_URL: optional(z.url()),
      COMMON_GROUP_ALERT_ON: intFlag(0),
      /** Legacy `common_redis_instance` (`POSAdmin/redis.py:8`); holds ORDER_CREATION_BUFFER_TIME_IN_SEC. */
      COMMON_REDIS_URL: optional(z.url()),
      HYPERLOCAL_CUT_OFF_SWITCH: intFlag(1),
      HYPERLOCAL_CUT_OFF_TIME: z
        .string()
        .regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$/)
        .default('17:00'),
      /** Customer JWT keys used by legacy `Helpers.create_token` (HS256, HS512 for 2FA users). */
      TSS_JWT_HS256_KEY: optional(z.string().min(32)),
      TSS_JWT_HS512_KEY: optional(z.string().min(32)),
      /** Legacy sends most of these requests without a timeout; the rewrite bounds them. */
      LEGACY_DELIVERY_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(30000),
    })
    .parse(env);
}
export type LegacyFulfillmentEnvironment = ReturnType<typeof readLegacyFulfillmentOptions>;

/** Constant-time comparison of a configured service credential (legacy compares with `==`). */
export function credentialMatches(expected: string | undefined, provided: unknown): boolean {
  const left = createHash('sha256')
    .update(expected || 'missing-configured-key')
    .digest();
  const right = createHash('sha256')
    .update(typeof provided === 'string' ? provided : 'missing-request-key')
    .digest();
  return timingSafeEqual(left, right) && Boolean(expected) && typeof provided === 'string';
}
