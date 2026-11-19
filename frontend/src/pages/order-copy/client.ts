import { z } from 'zod';
import { post } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,19}$/);
export interface OrderCopyScope {
  operatorId: string;
  storeId: string;
  checkoutId: string;
  customerId: string;
}
/** Legacy `ajax_fetch_the_products` reply messages (order/views.py:2103-2104). */
export const orderCopyResultSchema = z
  .object({
    orderId: id,
    partial: z.boolean(),
    message: z.enum(['Cart Synced', 'Cart partially synced - please review the cart']),
  })
  .strict();
export type OrderCopyResult = z.infer<typeof orderCopyResultSchema>;
export const copyOrder = (scope: OrderCopyScope, orderId: string) =>
  post(
    `/api/v1/stores/${encodeURIComponent(scope.storeId)}/checkout-sessions/${encodeURIComponent(scope.checkoutId)}/order-copies`,
    { orderId },
    orderCopyResultSchema,
    scope.operatorId,
  );

// TRANSITIONAL compatibility exports: `checkout/client.ts` still parses `orderCopy` with this
// schema and CheckoutReview still types `onUnsentCancelled`. The server no longer produces a copy
// binding or an unsent-cancellation proof; delete these once those callers drop them.
export const copyBindingSchema = z.discriminatedUnion('status', [
  z
    .object({
      commandId: z.uuid(),
      reviewId: z.uuid(),
      originHash: z.string().regex(/^[a-f0-9]{64}$/),
      status: z.enum(['pending', 'uncertain', 'review-required', 'acknowledged']),
      resultHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled-unsent'),
      commandId: z.uuid(),
      reviewId: z.uuid(),
      cancellationId: z.uuid(),
    })
    .strict(),
]);
export interface CopyCancellation {
  status: 'cancelled-unsent';
  id: string;
  reviewId: string;
  cancellationId: string;
  checkoutId: string;
}
