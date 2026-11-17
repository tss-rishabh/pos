import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const originalCopyInputSchema = z
  .object({
    operationId: z.uuid(),
    reviewId: z.uuid(),
    manifestHash: digest,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export const copyCancellationInputSchema = z
  .object({ operationId: z.uuid(), original: originalCopyInputSchema })
  .strict();
export type CopyCancellationInput = z.infer<typeof copyCancellationInputSchema>;
/** No source/customer/product/cart snapshot is claimed by a no-dispatch fence. */
export const copyCancellationReceiptSchema = z
  .object({
    status: z.literal('cancelled-unsent'),
    id: z.uuid(),
    reviewId: z.uuid(),
    cancellationId: z.uuid(),
    checkoutId: z.uuid(),
    operatorId: identifier,
    storeId: identifier,
    counterId: identifier,
    originalRequestHash: digest,
    cancelledAt: z.number().int().positive(),
    checkoutVersion: z.number().int().nonnegative(),
    requiresOnlineClear: z.literal(true),
    markerRequired: z.literal(true),
    source: z.null(),
    steps: z.array(z.never()).length(0),
    result: z.null(),
    resultHash: z.null(),
    originHash: z.null(),
    partial: z.literal(false),
    errorCode: z.null(),
    acknowledgementId: z.null(),
    canContinue: z.literal(false),
  })
  .strict();
export type CopyCancellationReceipt = z.infer<typeof copyCancellationReceiptSchema>;
