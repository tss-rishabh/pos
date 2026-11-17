import { z } from 'zod';
import { fullSyncContract } from './domain.js';
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export function readEcommerceSynchronizationOptions(environment: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      ECOMMERCE_FULL_SYNC_CONTRACT: optional(z.literal(fullSyncContract)),
      ECOMMERCE_FULL_SYNC_URL: optional(z.url()),
      ECOMMERCE_FULL_SYNC_SECRET: optional(z.string().min(32).max(256)),
      ECOMMERCE_FULL_SYNC_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(5000),
      ECOMMERCE_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
      ECOMMERCE_SYNC_MAX_PRODUCTS: z.coerce.number().int().min(1).max(200000).default(50000),
    })
    .parse(environment);
}
export type EcommerceSynchronizationOptions = ReturnType<
  typeof readEcommerceSynchronizationOptions
>;
