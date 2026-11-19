import { z } from 'zod';
import type { Config } from '../../config.js';
const optional = <T extends z.ZodType>(value: T) =>
  z.preprocess((input) => (input === '' ? undefined : input), value.optional());
/**
 * Legacy `BACKEND_SYNC_API_BASE_URL` (`settings.py:570`, `rstrip('/')`, default '') and
 * `BACKEND_SYNC_REPO_API_KEY` (`:571`, default ''). Unset base URL = legacy "skip" path.
 */
export function readWholeOrderStatusOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BACKEND_SYNC_API_BASE_URL: optional(z.url().max(2048)),
      BACKEND_SYNC_REPO_API_KEY: z.string().max(1024).default(''),
    })
    .parse(env);
}
export type WholeOrderStatusOptions = ReturnType<typeof readWholeOrderStatusOptions>;
/**
 * Security (W5): a base URL with credentials, query or fragment is refused, and production
 * requires HTTPS so the `x-api-key` never crosses the network in clear text. Returns the
 * base without trailing `/`, or undefined (skip) when unset or refused.
 */
export function syncRepoBaseUrl(
  config: Pick<Config, 'NODE_ENV'>,
  options: WholeOrderStatusOptions,
): string | undefined {
  if (!options.BACKEND_SYNC_API_BASE_URL) return undefined;
  const base = new URL(options.BACKEND_SYNC_API_BASE_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !['https:', 'http:'].includes(base.protocol) ||
    (base.protocol !== 'https:' && config.NODE_ENV === 'production' && !local)
  )
    return undefined;
  return options.BACKEND_SYNC_API_BASE_URL.replace(/\/+$/, '');
}
