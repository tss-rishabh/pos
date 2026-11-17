import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { generationError } from './history-generation-contracts.js';
export const generationOriginContract = 'pos-coupon-writer-origin-readonly-v1';
export const generationOriginIdentitySchema = z
  .object({ serverUuid: z.uuid(), sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/) })
  .strict();
export interface GenerationSourceOrigin {
  contract: typeof generationOriginContract;
  expected: z.infer<typeof generationOriginIdentitySchema>;
  database: () => ReturnType<Databases['get']>;
}
/** Explicit deployment-owned writer-origin connection using SELECT-only
 * credentials. No app primary/replica route or identity substitution exists. */
export function generationSourceOrigin(
  database: GenerationSourceOrigin['database'],
  expected: GenerationSourceOrigin['expected'],
): GenerationSourceOrigin {
  const parsed = generationOriginIdentitySchema.safeParse(expected);
  if (!parsed.success || typeof database !== 'function')
    throw generationError('ORIGIN_REQUIRED', 503);
  return Object.freeze({
    contract: generationOriginContract,
    expected: Object.freeze(parsed.data),
    database,
  });
}
