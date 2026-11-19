import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';

export const cancellationParamsSchema = z
  .object({ storeId: identifier, orderId: identifier })
  .strict();
/** Legacy posts only `order_id`, which the path carries; the body must be empty. */
export const cancellationInputSchema = z.object({}).strict();
export const cancellationContextSchema = z
  .object({ orderId: identifier, storeId: identifier, eligible: z.boolean() })
  .strict();
export type CancellationContext = z.infer<typeof cancellationContextSchema>;
export const cancellationResultSchema = z
  .object({
    orderId: identifier,
    storeId: identifier,
    status: z.literal('cancelled'),
    message: z.string(),
  })
  .strict();
export type CancellationResult = z.infer<typeof cancellationResultSchema>;
/** Legacy `msg` (order/views.py:2925). */
export const cancellationMessage = 'Order Cancel request processed.';
