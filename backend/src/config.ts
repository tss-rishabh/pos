import { z } from 'zod';
import { isIP } from 'node:net';

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
      DEMO_MODE: flag(false),
      SESSION_SECRET: z.string().min(32),
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
      OIDC_ISSUER: optionalUrl,
      REDIS_URL: optionalUrl,
      OIDC_CLIENT_ID: optionalText(z.string().min(1).max(1024)),
      OIDC_CLIENT_SECRET: optionalText(z.string().min(16).max(4096)),
      OIDC_REDIRECT_URI: optionalUrl,
      OIDC_EMAIL_DOMAINS: z
        .string()
        .max(2048)
        .default('thesouledstore.com,thesouledstore.co.in')
        .transform((value) => [
          ...new Set(
            value
              .split(',')
              .map((domain) => domain.trim().toLowerCase())
              .filter(Boolean),
          ),
        ])
        .refine(
          (domains) =>
            domains.every((domain) =>
              /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain),
            ),
          'Configure exact SSO email domains.',
        ),
      OIDC_REQUIRE_HOSTED_DOMAIN: flag(true),
      DESKTOP_SSO_ENABLED: flag(false),
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
    })
    .parse(env);
  if (config.NODE_ENV === 'production') {
    if (config.DEMO_MODE) throw new Error('DEMO_MODE is forbidden in production');
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
    for (const value of [config.OIDC_ISSUER, config.OIDC_REDIRECT_URI, config.TSS_API_BASE_URL])
      if (value && new URL(value).protocol !== 'https:')
        throw new Error('Production identity and application endpoints must use HTTPS.');
    if (config.SESSION_SECRET === 'replace-with-at-least-32-random-characters')
      throw new Error('Replace the example session secret before production.');
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
  if (config.DEMO_MODE)
    for (const raw of [
      config.MYSQL_WRITER_URL,
      config.MYSQL_PRIMARY_READER_URL,
      config.MYSQL_DATA_READER_URL,
      config.REDIS_URL,
      config.TSS_API_BASE_URL,
    ])
      if (raw && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(raw).hostname))
        throw new Error('Demo mode only supports isolated local dependencies.');
  if (!config.DEMO_MODE && !config.MYSQL_PRIMARY_READER_URL)
    throw new Error('Configure MYSQL_PRIMARY_READER_URL');
  return config;
}
export type Config = ReturnType<typeof readConfig>;
