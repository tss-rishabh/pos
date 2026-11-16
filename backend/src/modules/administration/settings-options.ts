import { z } from 'zod';

const flag = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
export function readSettingsWorkerOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      SETTINGS_WORKER_ENABLED: flag,
      SETTINGS_WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(2000),
      SETTINGS_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(25).default(5),
      COMMON_REDIS_URL: optionalUrl,
      SLACK_URL: optionalUrl,
      ECOM_DELIVERY_CHANGES_TIME: z.coerce.number().int().min(1).max(3600).default(180),
    })
    .parse(env);
}
export type SettingsWorkerOptions = ReturnType<typeof readSettingsWorkerOptions>;
