import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { amountSchema } from '../contracts.js';

export const paymentReversalContract = 'pos-payment-correction-v1';
export const paymentCorrectionFinanceContract = 'pos-payment-correction-cash-ledger-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const paymentReversalInputSchema = z
  .object({
    operationId: z.uuid(),
    originalPaymentId: z.uuid(),
    counterId: identifier,
    snapshotHash: digest,
    cashReturnReceiptId: z.uuid(),
    returnedCash: amountSchema,
    confirmCashReturned: z.literal(true),
    confirmNoHandover: z.literal(true),
    reason: z.enum(['incorrect-payment-record', 'customer-payment-correction']),
  })
  .strict();
export type PaymentReversalInput = z.infer<typeof paymentReversalInputSchema>;
export const paymentReversalReceiptSchema = z
  .object({
    id: z.uuid(),
    contract: z.literal(paymentReversalContract),
    status: z.literal('recorded'),
    orderId: identifier,
    storeId: identifier,
    counterId: identifier,
    operatorId: identifier,
    originalPaymentId: z.uuid(),
    originalPaymentHash: digest,
    transactionId: z.string().min(1).max(32),
    originalCash: amountSchema,
    originalCashReceived: amountSchema,
    originalFundingAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    orderDate: z.iso.date(),
    returnedCash: amountSchema,
    cashReturnReceiptId: z.uuid(),
    reason: paymentReversalInputSchema.shape.reason,
    recordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    businessDate: z.iso.date(),
    headerHash: digest,
    lines: z
      .array(
        z
          .object({
            id: identifier,
            productId: identifier,
            quantity: z.string().regex(/^[1-9]\d{0,2}$/),
            inputHash: digest,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    stockChanged: z.literal(false),
    benefitsChanged: z.literal(false),
    providerRefunded: z.literal(false),
    goodsRetainedAtCounter: z.literal(true),
  })
  .strict();
export type PaymentReversalReceipt = z.infer<typeof paymentReversalReceiptSchema>;
export const paymentReversalContextSchema = z
  .object({
    orderId: identifier,
    storeId: identifier,
    counterId: identifier,
    eligible: z.boolean(),
    blocker: z.string().nullable(),
    snapshotHash: digest.nullable(),
    originalPaymentId: z.uuid().nullable(),
    returnedCash: amountSchema.nullable(),
    latest: paymentReversalReceiptSchema.nullable(),
  })
  .strict();
export type PaymentReversalContext = z.infer<typeof paymentReversalContextSchema>;

export interface PaymentReversalOptions {
  contract?: string;
  financeContract?: string;
}
/** Blank settings leave the feature unavailable; a flag never certifies an external writer. */
export function paymentReversalOptions(
  env: NodeJS.ProcessEnv = process.env,
): PaymentReversalOptions {
  const parsed = z
    .object({
      POS_PAYMENT_REVERSAL_CONTRACT: z.literal(paymentReversalContract).optional(),
      POS_PAYMENT_CORRECTION_FINANCE_CONTRACT: z
        .literal(paymentCorrectionFinanceContract)
        .optional(),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  return {
    contract: parsed.POS_PAYMENT_REVERSAL_CONTRACT,
    financeContract: parsed.POS_PAYMENT_CORRECTION_FINANCE_CONTRACT,
  };
}
