import { z } from 'zod';
const id = z.string().regex(/^[1-9]\d{0,18}$/);
/** Whether legacy order/show.html:67-68 would show "Cancel Order" (method 14, Pending, Order Placed). */
export const cancellationContextSchema = z
  .object({ orderId: id, storeId: id, eligible: z.boolean() })
  .strict();
export const cancellationResultSchema = z
  .object({
    orderId: id,
    storeId: id,
    status: z.literal('cancelled'),
    message: z.string(),
  })
  .strict();
export type CancellationContext = z.infer<typeof cancellationContextSchema>;
export type CancellationResult = z.infer<typeof cancellationResultSchema>;
export const cancellationPath = (storeId: string, orderId: string) =>
  `/api/v1/stores/${encodeURIComponent(storeId)}/orders/${encodeURIComponent(orderId)}/cancellations`;
