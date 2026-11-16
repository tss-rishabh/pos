import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { sameToken } from '../application-links/domain.js';
import { customerWebsiteHandoffContract } from './contracts.js';
const flag = z
  .preprocess(
    (value) => (value === undefined || value === '' ? 'false' : value),
    z.enum(['true', 'false']),
  )
  .transform((value) => value === 'true');
export function readCustomerWebsiteHandoffOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      CUSTOMER_WEBSITE_HANDOFF_ENABLED: flag,
      CUSTOMER_WEBSITE_HANDOFF_CONTRACT: z.string().optional(),
      CUSTOMER_WEBSITE_HANDOFF_RECEIVER_URL: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.url().optional(),
      ),
      CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z
          .string()
          .regex(/^[!-~]{32,4096}$/)
          .optional(),
      ),
      CUSTOMER_WEBSITE_HANDOFF_TTL_SECONDS: z.coerce.number().int().min(15).max(120).default(60),
      CUSTOMER_WEBSITE_HANDOFF_SESSION_SECONDS: z.coerce
        .number()
        .int()
        .min(60)
        .max(900)
        .default(300),
    })
    .parse(env);
}
export type CustomerWebsiteHandoffOptions = ReturnType<typeof readCustomerWebsiteHandoffOptions>;
export function handoffUnavailable() {
  return new AppError(
    503,
    'CUSTOMER_WEBSITE_HANDOFF_UNAVAILABLE',
    'Customer website sign-in is not available.',
  );
}
export function configuredWebsiteHandoff(
  config: Pick<Config, 'DEMO_MODE' | 'SESSION_SECRET'>,
  options: CustomerWebsiteHandoffOptions,
) {
  if (
    config.DEMO_MODE ||
    !options.CUSTOMER_WEBSITE_HANDOFF_ENABLED ||
    options.CUSTOMER_WEBSITE_HANDOFF_CONTRACT !== customerWebsiteHandoffContract ||
    !options.CUSTOMER_WEBSITE_HANDOFF_RECEIVER_URL ||
    !options.CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY ||
    sameToken(options.CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY, config.SESSION_SECRET)
  )
    throw handoffUnavailable();
  const url = new URL(options.CUSTOMER_WEBSITE_HANDOFF_RECEIVER_URL);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/pos/secure-login'
  )
    throw handoffUnavailable();
  return { url, key: options.CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY };
}
