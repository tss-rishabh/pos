import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { wholeOrderStatusContract } from './domain.js';
const optional = <T extends z.ZodType>(value: T) =>
  z.preprocess((input) => (input === '' ? undefined : input), value.optional());
export function readWholeOrderStatusOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      WHOLE_ORDER_STATUS_CONTRACT: optional(z.string()),
      BACKEND_SYNC_API_BASE_URL: optional(z.url()),
      BACKEND_SYNC_REPO_API_KEY: optional(z.string().min(16).max(1024)),
      WHOLE_ORDER_STATUS_RECEIPT_KEY: optional(z.string().min(32).max(1024)),
      WHOLE_ORDER_STATUS_WORKER_ENABLED: z.preprocess(
        (value) =>
          value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
        z.boolean(),
      ),
      WHOLE_ORDER_STATUS_HTTP_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(500)
        .max(30000)
        .default(10000),
      WHOLE_ORDER_STATUS_CLAIM_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(60000)
        .max(3600000)
        .default(300000),
    })
    .parse(env);
}
export type WholeOrderStatusOptions = ReturnType<typeof readWholeOrderStatusOptions>;
export function qualifiedStatusEndpoint(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE'>,
  options: WholeOrderStatusOptions,
) {
  if (
    options.WHOLE_ORDER_STATUS_CONTRACT !== wholeOrderStatusContract ||
    !options.BACKEND_SYNC_API_BASE_URL ||
    !options.BACKEND_SYNC_REPO_API_KEY ||
    !options.WHOLE_ORDER_STATUS_RECEIPT_KEY
  )
    throw new AppError(
      503,
      'WHOLE_ORDER_STATUS_NOT_SENT',
      'The qualified whole-order status receipt adapter is not configured.',
    );
  let base: URL;
  try {
    base = new URL(options.BACKEND_SYNC_API_BASE_URL);
  } catch {
    throw new AppError(503, 'WHOLE_ORDER_STATUS_NOT_SENT', 'The status service origin is invalid.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !['https:', 'http:'].includes(base.protocol) ||
    (base.protocol !== 'https:' &&
      !(local && (config.NODE_ENV !== 'production' || config.DEMO_MODE)))
  )
    throw new AppError(
      503,
      'WHOLE_ORDER_STATUS_NOT_SENT',
      'The status service requires a configured HTTPS origin.',
    );
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return base;
}
