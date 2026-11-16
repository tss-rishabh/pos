import { z } from 'zod';
const id = z.string().regex(/^[1-9]\d{0,18}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const benefitAmount = z.string().regex(/^\d+(?:\.\d+)?$/);
export const cancellationBenefitsSchema = z
  .object({
    policy: z.literal('pos-cancellation-original-expiry-v1'),
    moneyCredited: benefitAmount,
    moneyExpired: benefitAmount,
    pointsCredited: benefitAmount,
    pointsExpired: benefitAmount,
    voucherCredited: benefitAmount,
    voucherAvailable: z.boolean().nullable(),
    membership: z.enum(['unchanged', 'deactivated', 'prior-entitlement-restored']),
  })
  .strict();
export const cancellationIntentSchema = z
  .object({ operationId: z.uuid(), snapshotHash: hash })
  .strict();
export const cancellationReceiptSchema = z
  .object({
    id: z.uuid(),
    orderId: id,
    storeId: id,
    counterId: id,
    operatorId: id,
    status: z.literal('cancelled'),
    cashRefunded: z.literal('0.00'),
    benefits: cancellationBenefitsSchema.optional(),
    cancelledAt: z.string(),
    snapshotHash: hash,
    restoredProducts: z
      .array(
        z
          .object({
            productId: id,
            quantity: z.number().int().positive(),
            before: z.number().int().nonnegative(),
            after: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    lineIds: z.array(id).min(1).max(1000),
    closeImpact: z
      .object({ id, priorStatus: z.string(), priorReason: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export const cancellationContextSchema = z
  .object({
    orderId: id,
    storeId: id,
    counterId: id,
    eligible: z.boolean(),
    benefits: cancellationBenefitsSchema.optional(),
    snapshotHash: hash.nullable(),
    blocker: z.string().nullable(),
    receipt: cancellationReceiptSchema.nullable(),
  })
  .strict();
export type CancellationIntent = z.infer<typeof cancellationIntentSchema>;
export const cancellationKey = (ownerId: string, storeId: string, orderId: string) =>
  `souled-order-cancellation:${ownerId}:${storeId}:${orderId}`;
export function readCancellationIntent(key: string): CancellationIntent | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return cancellationIntentSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    throw new Error(
      'The original cancellation reference needs review. Another cancellation cannot be started.',
    );
  }
}
