import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';

const signedId = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,18})$/)
  .refine(
    (value) => BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n,
  );
const wallClock = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDateTime.from(value).year >= 1000;
    } catch {
      return false;
    }
  });
export const feedbackFact = z
  .object({
    orderId: signedId.refine((value) => BigInt(value) > 0n),
    customerId: signedId.nullable(),
    associatedStoreId: signedId.nullable(),
    questionId: signedId
      .refine((value) => BigInt(value) >= -2147483648n && BigInt(value) <= 2147483647n)
      .nullable(),
    feedback: z.string().max(255).nullable(),
    feedbackDate: wallClock.nullable(),
    orderDate: wallClock,
  })
  .strict();
export type FeedbackFact = z.infer<typeof feedbackFact>;
export const feedbackHistoryResult = z
  .object({
    total: z
      .string()
      .regex(/^\d+$/)
      .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
    page: z.number().int().safe().positive(),
    items: z.array(feedbackFact).max(500),
  })
  .strict();
export const feedbackDimensionLimit = 500;
