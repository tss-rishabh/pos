import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const flag = z.preprocess(
  (value) =>
    value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
  z.boolean(),
);
export function catalogMaintenanceOptions(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z
    .object({
      CATALOG_MAINTENANCE_WORKER_ENABLED: flag,
      CATALOG_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(3000),
      CATALOG_MAINTENANCE_MAX_PENDING: z.coerce.number().int().min(1).max(100).default(20),
      INVENTORY_SYNC_URL: optional(z.url()),
      INVENTORY_SYNC_API_KEY: optional(z.string().regex(/^[\x21-\x7e]{1,512}$/)),
      INVENTORY_SYNC_HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).max(90000).default(90000),
    })
    .safeParse(env);
  if (!parsed.success)
    throw new AppError(
      503,
      'CATALOG_MAINTENANCE_CONFIGURATION_INVALID',
      'Catalog maintenance configuration is invalid.',
    );
  return parsed.data;
}
export type CatalogMaintenanceOptions = ReturnType<typeof catalogMaintenanceOptions>;
