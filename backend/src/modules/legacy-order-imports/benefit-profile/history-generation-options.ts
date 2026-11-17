import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { benefitHash } from './contracts.js';
import { generationRuntimeContract, generationError } from './history-generation-contracts.js';
const view = z.string().regex(/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/);
export const generationOptionsSchema = z
  .object({
    contract: z.literal(generationRuntimeContract).optional(),
    publications: view.optional(),
    candidates: view.optional(),
    orders: view.optional(),
    logs: view.optional(),
    controls: view.optional(),
    sourceOrdersByCustomer: view.optional(),
    sourceOrdersByCoupon: view.optional(),
    sourceTimeZone: z
      .string()
      .max(100)
      .refine((v) => {
        try {
          Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(v);
          return true;
        } catch {
          return false;
        }
      })
      .optional(),
    comparisonFingerprint: benefitHash.optional(),
    maxBytes: z.number().int().min(1).max(1000000000).default(50000000),
    timeoutMs: z.number().int().min(100).max(10000).default(8000),
    maxControls: z.number().int().min(1).max(10000).default(10000),
    maxLots: z.number().int().min(1).max(1000).default(1000),
    maxLagMs: z.number().int().min(1).max(60000).default(60000),
  })
  .strict();
export type GenerationOptions = z.infer<typeof generationOptionsSchema>;
export function readGenerationOptions(env: NodeJS.ProcessEnv = process.env) {
  const names: Record<string, string> = {
    contract: 'CSV_COUPON_GENERATION_CONTRACT',
    publications: 'BQ_CSV_COUPON_GENERATIONS_VIEW',
    candidates: 'BQ_CSV_COUPON_GENERATION_CANDIDATES_VIEW',
    orders: 'BQ_CSV_COUPON_GENERATION_ORDERS_VIEW',
    logs: 'BQ_CSV_COUPON_GENERATION_LOGS_VIEW',
    controls: 'BQ_CSV_COUPON_GENERATION_CONTROLS_VIEW',
    sourceOrdersByCustomer: 'BQ_CSV_COUPON_SOURCE_ORDERS_BY_CUSTOMER_VIEW',
    sourceOrdersByCoupon: 'BQ_CSV_COUPON_SOURCE_ORDERS_BY_COUPON_VIEW',
    sourceTimeZone: 'CSV_COUPON_SOURCE_TIMEZONE',
    comparisonFingerprint: 'CSV_COUPON_COMPARISON_FINGERPRINT',
    maxBytes: 'CSV_COUPON_MAX_BYTES_BILLED',
    timeoutMs: 'CSV_COUPON_QUERY_TIMEOUT_MS',
    maxControls: 'CSV_COUPON_MAX_CONTROLS',
    maxLots: 'CSV_COUPON_MAX_LOTS',
    maxLagMs: 'CSV_COUPON_GENERATION_MAX_LAG_MS',
  };
  const value = Object.fromEntries(
    Object.entries(names).map(([key, name]) => {
      const v = env[name];
      return [
        key,
        !v
          ? undefined
          : ['maxBytes', 'timeoutMs', 'maxControls', 'maxLots', 'maxLagMs'].includes(key)
            ? Number(v)
            : v,
      ];
    }),
  );
  const p = generationOptionsSchema.safeParse(value);
  if (!p.success) throw generationError('CONFIGURATION', 503);
  return p.data;
}
export function requireGenerationOptions(value: GenerationOptions, mode: 'read' | 'candidate') {
  const p = generationOptionsSchema.safeParse(value);
  if (!p.success) throw generationError('CONFIGURATION', 503);
  const o = p.data;
  if (
    o.contract !== generationRuntimeContract ||
    !o.sourceTimeZone ||
    !o.comparisonFingerprint ||
    !o.orders ||
    !o.logs ||
    !o.controls ||
    !(mode === 'read' ? o.publications : o.candidates)
  )
    throw generationError('REQUIRED', 503);
  const names = [o.publications, o.candidates, o.orders, o.logs, o.controls].filter(Boolean);
  if (new Set(names).size !== names.length) throw generationError('CONFIGURATION', 503);
  return o;
}
