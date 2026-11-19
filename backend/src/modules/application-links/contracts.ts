import { z } from 'zod';

const optional = <T>(schema: z.ZodType<T>) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const https = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  }, 'Use a trusted HTTPS application URL.');
const origin = https
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === '/' && !url.search;
  })
  .transform((value) => new URL(value).origin);
/**
 * Legacy settings (POSAdmin/settings.py:526-603): `APP_APK_URL`, `MPOS_DOWNLOAD_QR_EXP_SEC`,
 * `MPOS_DOWNLOAD_LINK_EXP`, `MAIN_SITE_API_V2`, `POS_APP_REDIRECT`. `POS_CUSTOMER_APP_ORIGINS`
 * is the rewrite's redirect allowlist (security decision).
 */
export function readApplicationLinkOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      APP_APK_URL: optional(https),
      MPOS_DOWNLOAD_QR_EXP_SEC: z.coerce.number().int().min(30).max(300).default(60),
      MPOS_DOWNLOAD_LINK_EXP: z.coerce.number().int().min(30).max(300).default(60),
      MAIN_SITE_API_V2: optional(
        https.refine(
          (value) => !new URL(value).search,
          'The application provider endpoint cannot contain query credentials.',
        ),
      ),
      POS_CUSTOMER_APP_ORIGINS: z
        .string()
        .max(4096)
        .default('https://www.thesouledstore.com')
        .transform((value) =>
          value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        )
        .pipe(z.array(origin).min(1).max(20))
        .transform((values) => [...new Set(values)]),
      POS_APP_REDIRECT: https.default('https://www.thesouledstore.com'),
    })
    .superRefine((value, context) => {
      if (!safeApplicationDestination(value.POS_APP_REDIRECT, value.POS_CUSTOMER_APP_ORIGINS))
        context.addIssue({
          code: 'custom',
          path: ['POS_APP_REDIRECT'],
          message: 'Use an approved application destination.',
        });
    })
    .parse(env);
}
export type ApplicationLinkOptions = ReturnType<typeof readApplicationLinkOptions>;
export const operation = z.object({ operationId: z.uuid() }).strict();
export const opaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const staffActivation = operation.extend({ token: opaqueToken }).strict();
export const staffContent = operation.extend({ activationToken: opaqueToken }).strict();
/** `{storeId}.{HMAC}`: the store id plus its deterministic per-store token. */
export const customerToken = z.string().regex(/^[1-9]\d{0,9}\.[A-Za-z0-9_-]{43}$/);
export const customerScan = operation.extend({ token: customerToken }).strict();
/** Legacy `GET /user_to_app?store_id=` (core/views.py:3182-3213). */
export const legacyCustomerScan = z.object({
  store_id: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .refine((value) => /^\d+$/.test(value) && BigInt(value) <= 2147483647n),
});
export function safeApplicationDestination(value: string, origins: readonly string[]) {
  try {
    if (value.length > 2048) return false;
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !origins.includes(url.origin)
    )
      return false;
    for (const [key, part] of url.searchParams) {
      if (key === 'store_id') {
        if (!/^[1-9]\d{0,9}$/.test(part) || BigInt(part) > 2147483647n) return false;
      } else if (key === 'id') {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{1,127}$/.test(part)) return false;
      } else return false;
    }
    return true;
  } catch {
    return false;
  }
}
