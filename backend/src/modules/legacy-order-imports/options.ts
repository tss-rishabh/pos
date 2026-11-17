import { z } from 'zod';

export const legacyOrderImportContract = 'pos-legacy-order-import-v1';
export function readLegacyOrderImportOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      LEGACY_ORDER_IMPORT_CONTRACT: z.literal(legacyOrderImportContract).optional(),
      LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: z
        .string()
        .regex(/^[\x21-\x7e]{32,4096}$/)
        .optional(),
      LEGACY_ORDER_IMPORT_WORKER_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
      LEGACY_ORDER_IMPORT_WORKER_INTERVAL_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .default(5000),
      LEGACY_ORDER_IMPORT_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
}
export type LegacyOrderImportOptions = ReturnType<typeof readLegacyOrderImportOptions>;
