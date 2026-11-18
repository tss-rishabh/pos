import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

export const performanceIdentifier = identifier.refine(
  (value) => BigInt(value) <= 9223372036854775807n,
);
const duration = z.string().regex(/^(?:|(?:0|[1-9]\d{0,15})\.\d{2})$/),
  overall = z
    .string()
    .regex(/^(?:|NaN|(?:0|[1-9]\d{0,15}))$/)
    .refine((value) => value === '' || value === 'NaN' || BigInt(value) <= 9007199254740991n);
export const performanceValues = z
  .object({
    product_main_list: duration,
    user_behaviour: duration,
    add_to_cart: duration,
    proceed_to_payment: duration,
    fast_payment: duration.optional(),
    overall_performance_time: overall,
  })
  .strict();
export type PerformanceValues = z.infer<typeof performanceValues>;
/** Match json.dumps separators for the fixed source ASCII string fields. */
export function sourcePerformanceJson(value: PerformanceValues): string {
  const parsed = performanceValues.parse(value),
    entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );
  return (
    '{' +
    entries.map(([key, item]) => JSON.stringify(key) + ': ' + JSON.stringify(item)).join(', ') +
    '}'
  );
}
export const performanceInput = z
  .object({ operationId: z.uuid(), orderId: performanceIdentifier, performance: performanceValues })
  .strict()
  .refine(
    (value) => Buffer.byteLength(sourcePerformanceJson(value.performance), 'ascii') <= 255,
    'Timing data must fit the source performance field.',
  );
export type PerformanceInput = z.infer<typeof performanceInput>;
export const performanceScope = z
  .object({ storeId: performanceIdentifier, checkoutId: z.uuid() })
  .strict();
export type PerformanceScope = z.infer<typeof performanceScope>;
export const performanceReceipt = z
  .object({
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    orderId: performanceIdentifier,
    status: z.literal('recorded'),
    performance: performanceValues,
    recordedAt: z.iso.datetime(),
  })
  .strict();
export type PerformanceReceipt = z.infer<typeof performanceReceipt>;
