import { z } from 'zod';
import { request } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,19}$/);
const money = z.string().regex(/^\d+\.\d{2}$/);
export const voucherReceiptSchema = z
  .object({
    operationId: z.uuid(),
    kind: z.enum(['issuance', 'conversion']),
    operatorId: id,
    customerId: id,
    voucherId: id,
    couponId: z.string().regex(/^(?:0|[1-9]\d*)$/),
    voucherCode: z.string().min(1).max(25),
    amount: money,
    voucherHistoryId: id,
    moneyHistoryId: id.nullable(),
    walletBefore: money.nullable(),
    walletAfter: money.nullable(),
    nonExpiring: z.boolean(),
    createdAt: z.string(),
    contract: z.literal('pos-global-vouchers-v1'),
    valueContract: z.enum(['pos-gift-voucher-integer-v1', 'pos-gift-voucher-exact-cents-v1']),
    checkoutId: z.uuid().nullable(),
    checkoutVersion: z.number().int().min(1).nullable(),
    status: z.literal('success'),
    message: z.string().max(400),
  })
  .strict();
export type VoucherReceipt = z.infer<typeof voucherReceiptSchema>;
export const voucherSelectionSchema = z
  .object({
    selectionId: z.uuid(),
    customerId: id,
    name: z.string().max(130),
    expiresAt: z.number().int().safe(),
  })
  .strict();
export type VoucherSelection = z.infer<typeof voucherSelectionSchema>;
export const voucherCapabilitySchema = z
  .object({
    enabled: z.boolean(),
    conversionEnabled: z.boolean(),
    exactCents: z.boolean(),
    nonExpiring: z.literal(true),
    contract: z.literal('pos-global-vouchers-v1'),
  })
  .strict();
export const voucherOperationSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('succeeded'), errorCode: z.null(), receipt: voucherReceiptSchema })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      errorCode: z.enum(['GIFT_CARD_PIN_INVALID', 'GIFT_CARD_PIN_LIMIT', 'GIFT_CARD_PIN_REQUIRED']),
      receipt: z.null(),
    })
    .strict(),
  z.object({ status: z.literal('cancelled'), errorCode: z.null(), receipt: z.null() }).strict(),
]);
export function readVoucherOperation(operatorId: string, operationId: string, signal: AbortSignal) {
  return request(
    `/api/v1/gift-voucher-operations/${operationId}`,
    { signal, operatorId },
    voucherOperationSchema,
  );
}
export function createVoucherIssuance(
  operatorId: string,
  input: { operationId: string; selectionId: string; amount: string },
  signal: AbortSignal,
) {
  return request(
    '/api/v1/gift-voucher-issuances',
    { method: 'POST', body: JSON.stringify(input), signal, operatorId },
    voucherReceiptSchema,
  );
}
export function createVoucherConversion(
  operatorId: string,
  storeId: string,
  checkoutId: string,
  input: {
    operationId: string;
    expectedVersion: number;
    voucherCode: string;
    giftCardPin?: string;
  },
  signal: AbortSignal,
) {
  return request(
    `/api/v1/stores/${storeId}/checkout-sessions/${checkoutId}/voucher-conversions`,
    { method: 'POST', body: JSON.stringify(input), signal, operatorId },
    voucherReceiptSchema,
  );
}
export function cancelVoucherIntent(
  operatorId: string,
  operationId: string,
  body:
    | { kind: 'issuance'; selectionId: string }
    | { kind: 'conversion'; storeId: string; checkoutId: string },
  signal: AbortSignal,
) {
  return request(
    `/api/v1/gift-voucher-operations/${operationId}/cancellations`,
    { method: 'POST', body: JSON.stringify(body), signal, operatorId },
    voucherOperationSchema,
  );
}
