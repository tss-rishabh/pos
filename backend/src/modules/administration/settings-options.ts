import { z } from 'zod';

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
/** Legacy settings integrations (`POSAdmin/settings.py:302-303,510,520`). */
export function readSettingsOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      COMMON_REDIS_URL: optionalUrl,
      SLACK_URL: optionalUrl,
      // Legacy `ENV.get("ECOM_DELIVERY_CHANGES_TIME", 180)` is a Redis EX in seconds with no upper
      // bound (`core/views.py:2112`); the legacy UAT env sets 7200. Cap at 30 days.
      ECOM_DELIVERY_CHANGES_TIME: z.coerce.number().int().min(1).max(2_592_000).default(180),
    })
    .parse(env);
}
export type SettingsOptionsEnvironment = ReturnType<typeof readSettingsOptions>;
