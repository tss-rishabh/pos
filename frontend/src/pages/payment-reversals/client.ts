import { z } from 'zod';
import { post } from '../../api/client';

const money = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
/** Legacy `AjaxPaymentStatusView` form (order/views.py:685-775). */
export const paymentStatusInputSchema = z
  .object({
    payType: z.union([z.literal(0), z.literal(1)]),
    transactionId: z.string().max(255).optional(),
    paymentStatus: z.number().int().min(1),
    orderStatus: z.number().int().min(0),
    message: z.string().max(255),
    offlinePayment: money,
    onlinePayment: money,
  })
  .strict();
export type PaymentStatusInput = z.infer<typeof paymentStatusInputSchema>;
export const paymentStatusResultSchema = z
  .object({ status: z.literal('success'), message: z.string() })
  .strict();
/** Local confirmation of one applied payment-status change. */
export interface CorrectionReceipt {
  id: string;
  storeId: string;
  orderId: string;
  payType: 0 | 1;
  message: string;
}
export interface CorrectionScope {
  ownerId: string;
  storeId: string;
  orderId: string;
}
export async function updatePaymentStatus(
  scope: CorrectionScope,
  input: PaymentStatusInput,
): Promise<CorrectionReceipt> {
  const result = await post(
    `/api/v1/stores/${encodeURIComponent(scope.storeId)}/orders/${encodeURIComponent(scope.orderId)}/payment-status`,
    paymentStatusInputSchema.parse(input),
    paymentStatusResultSchema,
    scope.ownerId,
  );
  return {
    id: crypto.randomUUID(),
    storeId: scope.storeId,
    orderId: scope.orderId,
    payType: input.payType,
    message: result.message,
  };
}
