import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
const text = (schema: z.ZodString) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
/**
 * Legacy settings (`POSAdmin/settings.py:438-446`): `SECRET_KEY` / `SECRET_KEY_512` sign the
 * customer JWT (the rewrite names them `TSS_JWT_HS256_KEY` / `TSS_JWT_HS512_KEY`, as checkout
 * does), `JWT_CUSTOM_EXPIRY_MIN` default 10, `WEB_URL` default the public website,
 * `WEB_LOGIN_API_KEY` default ''.
 */
export function readCustomerWebsiteHandoffOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      TSS_JWT_HS256_KEY: text(z.string().min(32)),
      TSS_JWT_HS512_KEY: text(z.string().min(32)),
      JWT_CUSTOM_EXPIRY_MIN: z.coerce.number().int().min(1).max(1440).default(10),
      WEB_URL: z.preprocess(
        (value) => (value === '' || value === undefined ? 'https://www.thesouledstore.com' : value),
        z.url(),
      ),
      WEB_LOGIN_API_KEY: z.string().max(1024).default(''),
    })
    .parse(env);
}
export type CustomerWebsiteHandoffOptions = ReturnType<typeof readCustomerWebsiteHandoffOptions>;
export function handoffUnavailable() {
  return new AppError(
    503,
    'CUSTOMER_WEBSITE_HANDOFF_UNAVAILABLE',
    'Customer website sign-in is not configured.',
  );
}
/** Security (W5): the URL carries a login token, so it is built only over HTTPS. */
export function websiteBase(options: CustomerWebsiteHandoffOptions) {
  const url = new URL(options.WEB_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw handoffUnavailable();
  return options.WEB_URL;
}
