import { z } from 'zod';
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const flag = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
export function readAdministrationWorkerOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      ADMINISTRATION_WORKER_ENABLED: flag,
      ADMINISTRATION_WORKER_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(2000),
      ADMINISTRATION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
      ADMINISTRATION_WORKER_BATCH_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .default(20000),
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
