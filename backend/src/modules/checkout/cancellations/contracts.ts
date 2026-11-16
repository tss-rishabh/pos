import { z } from 'zod';
import { cancellationBenefitSummarySchema } from './benefit-contracts.js';
import { identifier } from '../../../domain/validation.js';
export const pendingCancellationContract = 'pos-pending-order-cancellation-v1';
export const cancellationInputSchema = z
  .object({ operationId: z.uuid(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type CancellationInput = z.infer<typeof cancellationInputSchema>;
export const cancellationReceiptSchema = z
  .object({
    id: z.uuid(),
    orderId: identifier,
    storeId: identifier,
    counterId: identifier,
    operatorId: identifier,
    status: z.literal('cancelled'),
    cashRefunded: z.literal('0.00'),
    benefits: cancellationBenefitSummarySchema.optional(),
    cancelledAt: z.string(),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    restoredProducts: z
      .array(
        z
          .object({
            productId: identifier,
            quantity: z.number().int().positive(),
            before: z.number().int().nonnegative(),
            after: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    lineIds: z.array(identifier).min(1).max(1000),
    closeImpact: z
      .object({ id: identifier, priorStatus: z.string(), priorReason: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type CancellationReceipt = z.infer<typeof cancellationReceiptSchema>;
