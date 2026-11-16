import { z } from 'zod';
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const flag = (fallback = false) =>
  z.preprocess(
    (value) =>
      value === undefined
        ? fallback
        : ['true', '1', 1, true].includes(value as string | number | boolean)
          ? true
          : ['false', '0', 0, false].includes(value as string | number | boolean)
            ? false
            : value,
    z.boolean(),
  );
export function readLegacyLifecycleOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      APP_ID: optional(z.string().min(1).max(128)),
      APP_KEY: optional(z.string().min(16).max(1024)),
      TSS_OBERVER_URL: optional(z.url()),
      TSS_OBERVER_APP_ID: optional(z.string().min(1).max(128)),
      TSS_OBERVER_APP_KEY: optional(z.string().min(16).max(1024)),
      MAIN_API_V2_URL: optional(z.url()),
      MJML_HOST: optional(z.url()),
      ORDER_PRODUCER_URL: optional(z.url()),
      ORDER_PRODUCER_APP_ID: optional(z.string().min(1).max(128)),
      ORDER_PRODUCER_APP_KEY: optional(z.string().min(16).max(1024)),
      SLACK_URL: optional(z.url()),
      COMMON_GROUP_ALERT_ON: flag(),
      BAMBOO_TOOTHBRUSH_EM: optional(z.string().regex(/^[1-9]\d{0,19}$/)),
      WELCOME_NOTE_PRODUCT_ID: optional(z.string().regex(/^[1-9]\d{0,19}$/)),
      LEGACY_DELIVERY_RECONCILIATION_URL: optional(z.url()),
      LEGACY_DELIVERY_RECONCILIATION_KEY: optional(z.string().min(32).max(1024)),
      LEGACY_DELIVERY_MOVEMENT_CONTRACT: optional(z.literal('pos-local-delivery-movement-v1')),
      LEGACY_DELIVERY_WORKER_ENABLED: flag(),
      LEGACY_DELIVERY_WORKER_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(1000),
      LEGACY_DELIVERY_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
      LEGACY_DELIVERY_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(15000),
      HYPERLOCAL_CUT_OFF_SWITCH: flag(true),
      HYPERLOCAL_CUT_OFF_TIME: z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
        .default('17:00'),
    })
    .parse(env);
}
export type LegacyLifecycleOptions = ReturnType<typeof readLegacyLifecycleOptions>;
