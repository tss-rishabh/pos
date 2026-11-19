import { z } from 'zod';

const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
/** Legacy settings integrations (`POSAdmin/settings.py:302-303,510,520`). */
export function readSettingsOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      COMMON_REDIS_URL: optionalUrl,
      SLACK_URL: optionalUrl,
      ECOM_DELIVERY_CHANGES_TIME: z.coerce.number().int().min(1).max(3600).default(180),
    })
    .parse(env);
}
export type SettingsOptionsEnvironment = ReturnType<typeof readSettingsOptions>;
