import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { sourceCashbackCreditMessage } from './domain/checkout-quote-display.js';

const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.url().optional());
const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const warehouseTable = optionalText(
  z.string().regex(/^[a-z][a-z0-9-]+\.[A-Za-z_]\w*\.[A-Za-z_]\w*$/),
);
const flag = (fallback: boolean) =>
  z.preprocess(
    (v) => (v === undefined ? fallback : v === 'true' ? true : v === 'false' ? false : v),
    z.boolean(),
  );

/**
 * Legacy `int(ENV.get(NAME, default))` (POSAdmin/settings.py). Python `int()` accepts surrounding
 * whitespace, an optional sign and single underscores between digits; anything else (including an
 * empty value) raises at startup, so it fails config validation here too.
 */
export const legacyInt = (fallback: number) =>
  z.preprocess(
    (value) => (value === undefined ? String(fallback) : value),
    z
      .string()
      .regex(/^\s*[+-]?\d+(?:_\d+)*\s*$/, 'Expected a legacy integer setting.')
      .transform((value) => Number(value.trim().replaceAll('_', '')))
      .pipe(z.number().int().safe()),
  );
/**
 * Legacy `EXCHANGE_ENABLED_STORE_IDS` (POSAdmin/settings.py:588-592): default "1", stripped;
 * "all" (any case) enables every store; otherwise comma-separated ints, blank parts skipped.
 */
export const exchangeStoreIds = z
  .string()
  .default('1')
  .transform((raw, context) => {
    const value = raw.trim();
    if (value.toLowerCase() === 'all') return { all: true as const, storeIds: [] as string[] };
    const storeIds: string[] = [];
    for (const part of value.split(',')) {
      if (!part.trim()) continue;
      if (!/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(part)) {
        context.addIssue({
          code: 'custom',
          message: 'EXCHANGE_ENABLED_STORE_IDS must be "all" or comma-separated integers.',
        });
        return z.NEVER;
      }
      storeIds.push(String(BigInt(part.trim().replaceAll('_', ''))));
    }
    return { all: false as const, storeIds };
  });

/**
 * Indian-number normalisation for allowlist matching. The senders pass `users.telephone` /
 * `orders.phone_no` to the providers as stored (10 digits, which Gupshup reads as +91); stored
 * values also appear as `+91…`, `91…` or `0…`. All of them compare as the 10-digit subscriber
 * number; other lengths keep their digits.
 */
export function normaliseIndianPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}
export const normaliseAllowlistEmail = (raw: string) => raw.trim().toLowerCase();
/** Slack webhooks are bearer credentials: the allowlist keeps only their SHA-256. */
export function slackWebhookDigest(raw: string | URL): string {
  let value = String(raw).trim();
  try {
    value = new URL(value).href;
  } catch {
    /* Compared verbatim when it is not a URL. */
  }
  return createHash('sha256').update(value).digest('hex');
}
const commaList = (variable: string, valid: (value: string) => boolean) =>
  z
    .string()
    .default('')
    .transform((raw, context) => {
      const values = raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      // The message never echoes a value: the lists hold real contacts and webhook secrets.
      if (!values.every(valid)) {
        context.addIssue({ code: 'custom', message: `${variable} contains an invalid entry.` });
        return z.NEVER;
      }
      return values;
    });
/**
 * UAT outbound-recipient allowlist (backend/parity/w25-allowlist.md). Optional; when enabled at
 * least one list must be non-empty, and every sender delivers only to listed recipients.
 */
export const outboundAllowlistEnvironment = z.object({
  // An empty value (the .env.example placeholder) means the default, false.
  OUTBOUND_ALLOWLIST_ENABLED: z.preprocess((v) => (v === '' ? undefined : v), flag(false)),
  OUTBOUND_ALLOWLIST_PHONES: commaList('OUTBOUND_ALLOWLIST_PHONES', (value) =>
    /^\d{8,15}$/.test(normaliseIndianPhone(value)),
  ),
  OUTBOUND_ALLOWLIST_EMAILS: commaList(
    'OUTBOUND_ALLOWLIST_EMAILS',
    (value) => z.email().safeParse(value).success,
  ),
  OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS: commaList(
    'OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS',
    (value) => z.url({ protocol: /^https$/ }).safeParse(value).success,
  ),
});
export interface OutboundAllowlist {
  enabled: boolean;
  phones: ReadonlySet<string>;
  emails: ReadonlySet<string>;
  slackWebhookDigests: ReadonlySet<string>;
}
export function outboundAllowlistFrom(
  value: z.infer<typeof outboundAllowlistEnvironment>,
): OutboundAllowlist {
  const allowlist = {
    enabled: value.OUTBOUND_ALLOWLIST_ENABLED,
    phones: new Set(value.OUTBOUND_ALLOWLIST_PHONES.map(normaliseIndianPhone)),
    emails: new Set(value.OUTBOUND_ALLOWLIST_EMAILS.map(normaliseAllowlistEmail)),
    slackWebhookDigests: new Set(value.OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS.map(slackWebhookDigest)),
  };
  if (
    allowlist.enabled &&
    !allowlist.phones.size &&
    !allowlist.emails.size &&
    !allowlist.slackWebhookDigests.size
  )
    throw new Error(
      'OUTBOUND_ALLOWLIST_ENABLED requires at least one of OUTBOUND_ALLOWLIST_PHONES, OUTBOUND_ALLOWLIST_EMAILS or OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS.',
    );
  return allowlist;
}
export function readOutboundAllowlist(env: NodeJS.ProcessEnv = process.env): OutboundAllowlist {
  return outboundAllowlistFrom(outboundAllowlistEnvironment.parse(env));
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65535).default(4410),
      WEB_ORIGIN: z.url().default('http://localhost:5173'),
      TRUSTED_PROXY_CIDRS: z
        .string()
        .default('')
        .transform((value) =>
          value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
        )
        .refine(
          (values) =>
            values.every((value) => {
              const [address, prefix, ...extra] = value.split('/'),
                family = isIP(address || '');
              return (
                family !== 0 &&
                extra.length === 0 &&
                (prefix === undefined ||
                  (/^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)))
              );
            }),
          'Configure explicit proxy IPs or CIDR ranges.',
        ),
      CASHBACK_CREDIT_MESSAGE: z.string().max(2000).default(sourceCashbackCreditMessage),
      SESSION_SECRET: z.string().min(32),
      // Secure session cookies; false only for local http development, refused in production.
      SESSION_COOKIE_SECURE: flag(true),
      // Global per-client-IP request budget (@fastify/rate-limit, per minute).
      API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(60).max(100000).default(240),
      LOGIN_MFA_PENDING_TTL: z.coerce.number().int().min(60).max(900).default(300),
      LOGIN_OTP_EXPIRY: z.coerce.number().int().min(30).max(600).default(180),
      LOGIN_OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
      LOGIN_OTP_RETRY_INTERVAL: z.coerce.number().int().min(1).max(120).default(30),
      LOGIN_OTP_LOCK_SECONDS: z.coerce.number().int().min(60).max(86400).default(10800),
      LOGIN_OTP_RESEND_COOLDOWN: z.coerce.number().int().min(1).max(120).default(30),
      BUSINESS_TIMEZONE: z
        .string()
        .default('Asia/Kolkata')
        .refine((value) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: value });
            return true;
          } catch {
            return false;
          }
        }, 'Configure a valid business time zone.'),
      MYSQL_WRITER_URL: optionalUrl,
      MYSQL_PRIMARY_READER_URL: optionalUrl,
      MYSQL_DATA_READER_URL: optionalUrl,
      MYSQL_TLS_CA_FILE: z.string().optional(),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: flag(false),
      MYSQL_POOL_SIZE: z.coerce.number().int().min(1).max(64).default(8),
      REDIS_URL: optionalUrl,
      BIGQUERY_PROJECT_ID: z.string().optional(),
      BIGQUERY_DATASET: optionalText(z.string().regex(/^[A-Za-z_]\w*$/)),
      BIGQUERY_DAILY_ROLLUP_TABLE: warehouseTable,
      BIGQUERY_FOOTFALL_TABLE: warehouseTable,
      BIGQUERY_TARGETS_TABLE: warehouseTable,
      DAY_CLOSE_ENABLED_STORE_IDS: z.string().max(10000).default('COCO'),
      DAY_CLOSE_OPEN_TIME: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .default('22:00'),
      DAY_CLOSE_CUTOFF_TIME: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .default('21:00'),
      DAY_CLOSE_CUTOFF_DAYS: z.coerce.number().int().min(0).max(7).default(1),
      DAY_CLOSE_NAG_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
      DAY_CLOSE_NAG_EVENING_START: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .default('22:30'),
      DAY_CLOSE_NAG_MORNING_START: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .default('09:00'),
      DAY_CLOSE_TOLERANCE: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .default('0'),
      BIGQUERY_LOCATION: z.string().default('asia-south1'),
      BIGQUERY_MAX_BYTES_BILLED: z.coerce.number().int().positive().default(1_000_000_000),
      TSS_API_BASE_URL: optionalUrl,
      TSS_API_MIGRATION_V2: flag(true),
      // Legacy checkout flags (backend/parity/legacy-flags.md), exact legacy defaults and parsing.
      GLOBAL_SHOW_COUPON_MODULE: legacyInt(1),
      GLOBAL_SHOW_PG_DISCOUNT_MODULE: legacyInt(1),
      ENABLE_OLD_PG_DISCOUNT: legacyInt(1),
      ENABLE_NEW_PG_DISCOUNT: legacyInt(1),
      ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT: legacyInt(0),
      TEN_PER_SWITCH: legacyInt(1),
      EXCHANGE_ENABLED_STORE_IDS: exchangeStoreIds,
      ...outboundAllowlistEnvironment.shape,
    })
    .parse(env);
  // Allowed in every environment, production included: it only ever stops messages.
  const outboundAllowlist = outboundAllowlistFrom(config);
  if (config.NODE_ENV === 'production') {
    if (!config.WEB_ORIGIN.startsWith('https:'))
      throw new Error('Production WEB_ORIGIN must use HTTPS');
    if (config.MYSQL_ALLOW_LOCAL_PLAINTEXT)
      throw new Error('Plaintext MySQL is forbidden in production');
    if (
      !config.MYSQL_WRITER_URL ||
      !config.MYSQL_PRIMARY_READER_URL ||
      !config.MYSQL_DATA_READER_URL
    )
      throw new Error(
        'Production requires writer, primary-reader and data-reader database configuration.',
      );
    if (config.TSS_API_BASE_URL && new URL(config.TSS_API_BASE_URL).protocol !== 'https:')
      throw new Error('Production application endpoints must use HTTPS.');
    if (config.SESSION_SECRET === 'replace-with-at-least-32-random-characters')
      throw new Error('Replace the example session secret before production.');
    if (!config.SESSION_COOKIE_SECURE)
      throw new Error('Production session cookies must be Secure.');
    if (!config.REDIS_URL)
      throw new Error('Production requires REDIS_URL for sessions and login OTP state.');
  }
  const webOrigin = new URL(config.WEB_ORIGIN);
  if (
    webOrigin.username ||
    webOrigin.password ||
    webOrigin.search ||
    webOrigin.hash ||
    webOrigin.pathname !== '/'
  )
    throw new Error('WEB_ORIGIN must contain only the web application origin.');
  if (!config.MYSQL_PRIMARY_READER_URL) throw new Error('Configure MYSQL_PRIMARY_READER_URL');
  return { ...config, outboundAllowlist };
}
export type Config = ReturnType<typeof readConfig>;
