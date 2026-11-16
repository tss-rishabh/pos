import { z } from 'zod';
const base = z.object({
  status: z.literal('paid'),
  orderId: z.string().regex(/^[1-9]\d*$/),
  receiptId: z.uuid(),
  transactionId: z.string(),
  cashAmount: z.string(),
  onlineAmount: z.string(),
});
export const confirmedPaymentSchema = z
  .discriminatedUnion('source', [
    base.extend({ source: z.literal('counter'), paymentAttemptId: z.uuid() }),
    base.extend({
      source: z.literal('prepaid'),
      checkoutId: z.uuid(),
      checkoutOperationId: z.uuid(),
      cashAmount: z.literal('0.00'),
      onlineAmount: z.literal('0.00'),
    }),
  ])
  .refine(
    (receipt) =>
      receipt.receiptId ===
      (receipt.source === 'counter' ? receipt.paymentAttemptId : receipt.checkoutOperationId),
    'Receipt identity does not match its settlement evidence.',
  );
export type ConfirmedPayment = z.infer<typeof confirmedPaymentSchema>;
