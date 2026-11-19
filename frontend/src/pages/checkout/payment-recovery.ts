import { z } from 'zod';

const amount = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
const identifier = z.string().regex(/^[1-9]\d{0,18}$/);
/** The exact counter payment request, saved before dispatch so a lost response can be recovered. */
export const recordedPaymentInputSchema = z
  .object({
    operationId: z.uuid(),
    channel: z.enum([
      'cash',
      'other',
      'district',
      'pincode',
      'pine-card',
      'pine-upi',
      'pine',
      'paytm-card',
      'paytm-qr',
    ]),
    paymentMode: z.number().int().min(1).max(2147483647).optional(),
    cashAmount: amount,
    onlineAmount: amount,
    cashReceived: amount,
    machineId: identifier.optional(),
    externalReference: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/)
      .optional(),
    /** The legacy cash/card breakdown note stored in order_stores.message. */
    message: z.string().max(255).optional(),
  })
  .strict();
export type RecordedPaymentInput = z.infer<typeof recordedPaymentInputSchema>;
export const recordedPaymentIntentSchema = z
  .object({ version: z.literal(2), kind: z.literal('payment'), input: recordedPaymentInputSchema })
  .strict();
export type RecordedPaymentIntent = z.infer<typeof recordedPaymentIntentSchema>;
export interface PaymentRecovery {
  attemptId: string;
  intent: RecordedPaymentIntent | null;
}
export const paymentStorageKey = (ownerId: string, draftId: string, orderId: string) =>
  `souled-payment:${ownerId}:${draftId}:${orderId}`;
export function readPaymentRecovery(key: string): PaymentRecovery | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  if (z.uuid().safeParse(raw).success) return { attemptId: raw, intent: null };
  try {
    const intent = recordedPaymentIntentSchema.parse(JSON.parse(raw) as unknown);
    return { attemptId: intent.input.operationId, intent };
  } catch {
    throw new Error('The saved payment reference needs review before another payment can start.');
  }
}
export function savePaymentRecovery(key: string, intent: RecordedPaymentIntent): PaymentRecovery {
  const validated = recordedPaymentIntentSchema.parse(intent);
  localStorage.setItem(key, JSON.stringify(validated));
  return { attemptId: validated.input.operationId, intent: validated };
}
export function clearPaymentRecovery(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Nothing to clear when storage is unavailable. */
  }
}
