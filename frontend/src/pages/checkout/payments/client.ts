import { z } from 'zod';
import { post, request } from '../../../api/client';

const id = z.string().regex(/^[1-9]\d{0,19}$/),
  money = z.string().regex(/^\d+\.\d{2}$/);
export const paymentContextSchema = z
  .object({
    orderId: id,
    storeId: id,
    counterId: z.string(),
    payable: money,
    paid: z.boolean(),
    settlement: z
      .object({ transactionId: z.string(), cashAmount: money, onlineAmount: money })
      .strict()
      .nullable(),
    /** Next legacy transaction id (`Helpers.get_transaction_id`). */
    transactionId: z.string(),
    activeTransaction: z
      .object({
        provider: z.enum(['pine', 'paytm']),
        transactionId: z.string(),
        reference: z.string().nullable(),
        onlineAmount: money,
        cashAmount: money,
      })
      .strict()
      .nullable(),
    canRecordPayment: z.boolean(),
    blocker: z.string().nullable(),
  })
  .strict();
export type PaymentContext = z.infer<typeof paymentContextSchema>;
export const paymentOptionsSchema = z
  .object({
    payable: money,
    counterId: z.string(),
    options: z.array(
      z
        .object({
          value: z.string(),
          label: z.string(),
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
          paymentMode: z.number().int(),
          machineId: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type PaymentOptions = z.infer<typeof paymentOptionsSchema>;
export type PaymentOption = PaymentOptions['options'][number];
export const paymentResultSchema = z
  .object({
    attemptId: z.uuid().nullable(),
    orderId: id,
    transactionId: z.string(),
    provider: z.enum(['cash', 'others', 'pine', 'paytm']),
    status: z.enum(['dispatching', 'pending', 'paid', 'failed', 'cancelled', 'uncertain']),
    legacyStatus: z.string(),
    message: z.string(),
    cashAmount: money,
    onlineAmount: money,
  })
  .strict();
export type PaymentResult = z.infer<typeof paymentResultSchema>;

export const orderPath = (storeId: string, orderId: string) =>
  `/api/v1/stores/${encodeURIComponent(storeId)}/orders/${encodeURIComponent(orderId)}`;
export const readPaymentContext = (
  storeId: string,
  orderId: string,
  operatorId: string,
  signal?: AbortSignal,
) =>
  request(
    orderPath(storeId, orderId) + '/payment-context',
    { operatorId, signal },
    paymentContextSchema,
  );
export const readPaymentOptions = (storeId: string, orderId: string, operatorId: string) =>
  request(orderPath(storeId, orderId) + '/payment-options', { operatorId }, paymentOptionsSchema);
export const readPaymentAttempt = (
  storeId: string,
  orderId: string,
  operatorId: string,
  attemptId: string,
) =>
  request(
    orderPath(storeId, orderId) + '/payment-attempts/' + encodeURIComponent(attemptId),
    { operatorId },
    paymentResultSchema,
  );
export const startPayment = (storeId: string, orderId: string, operatorId: string, body: unknown) =>
  post(orderPath(storeId, orderId) + '/payment-attempts', body, paymentResultSchema, operatorId);
const terminalPath = (storeId: string, orderId: string, transactionId: string) =>
  orderPath(storeId, orderId) + '/terminal-transactions/' + encodeURIComponent(transactionId);
export const checkTerminalStatus = (
  storeId: string,
  orderId: string,
  operatorId: string,
  transactionId: string,
) =>
  post(
    terminalPath(storeId, orderId, transactionId) + '/status-checks',
    {},
    paymentResultSchema,
    operatorId,
  );
export const cancelTerminalTransaction = (
  storeId: string,
  orderId: string,
  operatorId: string,
  transactionId: string,
) =>
  post(
    terminalPath(storeId, orderId, transactionId) + '/cancellations',
    {},
    paymentResultSchema,
    operatorId,
  );

/** Stable receipt identity for a settlement observed without a local attempt id. */
export function settlementReceiptId(orderId: string, transactionId: string): string {
  const text = `${orderId}:${transactionId}`;
  let hex = '';
  for (let seed = 0; seed < 4; seed++) {
    let hash = 0x811c9dc5 ^ (seed * 0x9e3779b1);
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hex += (hash >>> 0).toString(16).padStart(8, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
