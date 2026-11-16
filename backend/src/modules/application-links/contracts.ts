import { isAbsolute } from 'node:path';
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
export function readApplicationLinkOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      POS_STAFF_APK_ENABLED: z.preprocess(
        (value) =>
          value === undefined || value === 'false' ? false : value === 'true' ? true : value,
        z.boolean(),
      ),
      POS_STAFF_APK_PATH: optional(
        z.string().max(4096).refine(isAbsolute, 'Use an absolute approved package path.'),
      ),
      POS_STAFF_APK_SHA256: optional(z.string().regex(/^[a-f0-9]{64}$/)),
      POS_STAFF_APK_BYTES: optional(z.coerce.number().int().min(4).max(536870912)),
      MPOS_DOWNLOAD_QR_EXP_SEC: z.coerce.number().int().min(30).max(300).default(60),
      MPOS_DOWNLOAD_LINK_EXP: z.coerce.number().int().min(30).max(300).default(60),
      POS_CUSTOMER_APP_MODE: z.enum(['disabled', 'fallback', 'provider']).default('disabled'),
      POS_CUSTOMER_APP_LINK_ENDPOINT: optional(
        https.refine(
          (value) => !new URL(value).search,
          'The application provider endpoint cannot contain query credentials.',
        ),
      ),
      POS_CUSTOMER_APP_LINK_CONTRACT: optional(z.literal('verified-pos-app-link-v1')),
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
      POS_CUSTOMER_APP_WEBSITE: origin.default('https://www.thesouledstore.com'),
      POS_APP_REDIRECT: https.default('https://www.thesouledstore.com'),
    })
    .superRefine((value, context) => {
      if (
        value.POS_STAFF_APK_ENABLED &&
        (!value.POS_STAFF_APK_PATH || !value.POS_STAFF_APK_SHA256 || !value.POS_STAFF_APK_BYTES)
      )
        context.addIssue({
          code: 'custom',
          message: 'The staff package needs an approved file, checksum and size.',
        });
      if (
        value.POS_CUSTOMER_APP_MODE === 'provider' &&
        (!value.POS_CUSTOMER_APP_LINK_ENDPOINT || !value.POS_CUSTOMER_APP_LINK_CONTRACT)
      )
        context.addIssue({
          code: 'custom',
          message: 'The customer link provider needs a verified contract and endpoint.',
        });
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
export const customerScan = operation.extend({ token: opaqueToken }).strict();
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
