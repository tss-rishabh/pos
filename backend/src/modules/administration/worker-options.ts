import { z } from 'zod';
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const flag = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
/**
 * Product-sync endpoint options (legacy `PRODUCT_SYNC_URI`, `MAIN_API_V2_URL`, `API_V2_URL`).
 * The administration outbox worker is gone; the name is kept for existing importers.
 */
export function readAdministrationWorkerOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      PRODUCT_SYNC_HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(5000),
      PRODUCT_SYNC_REPLAY_SAFE: flag,
      PRODUCT_SYNC_URI: optional(z.string().regex(/^\/?[A-Za-z0-9][A-Za-z0-9/_-]{0,511}$/)),
      PRODUCT_SYNC_BASE_URL: optional(z.url()),
      MAIN_API_V2_URL: optional(z.url()),
      API_V2_URL: optional(z.url()),
    })
    .parse(env);
}
export type AdministrationWorkerOptions = ReturnType<typeof readAdministrationWorkerOptions>;
