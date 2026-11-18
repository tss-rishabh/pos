import { z } from 'zod';
import { request } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,19}$/);
const money = z.string().regex(/^\d+\.\d{2}$/);
export const voucherReceiptSchema = z
  .object({
    operationId: z.uuid(),
    kind: z.literal('issuance'),
    operatorId: id,
    customerId: id,
    voucherId: id,
    couponId: z.string().regex(/^(?:0|[1-9]\d*)$/),
    voucherCode: z.string().min(1).max(25),
    amount: money,
    voucherHistoryId: id,
    nonExpiring: z.literal(true),
    createdAt: z.string(),
    status: z.literal('success'),
    message: z.string().max(400),
  })
  .strict();
export type VoucherReceipt = z.infer<typeof voucherReceiptSchema>;
export const voucherConversionResultSchema = z
  .object({
    operationId: z.uuid(),
    kind: z.literal('conversion'),
    operatorId: id,
    customerId: id,
    storeId: id,
    checkoutId: z.uuid(),
    voucherCode: z.string().min(1).max(25),
    pinUsed: z.boolean(),
    status: z.literal('success'),
    message: z.string().max(400),
  })
  .strict();
export type VoucherConversionResult = z.infer<typeof voucherConversionResultSchema>;
export const voucherCheckResultSchema = z
  .object({
    voucherCode: z.string().min(1).max(25),
    voucherValue: z.string().max(32),
    validity: z.string().max(32).nullable(),
    nonExpiring: z.boolean(),
    pinUsed: z.boolean(),
  })
  .strict();
export type VoucherCheckResult = z.infer<typeof voucherCheckResultSchema>;
export const voucherSelectionSchema = z
  .object({
    selectionId: z.uuid(),
    customerId: id,
    name: z.string().max(130),
    expiresAt: z.number().int().safe(),
  })
  .strict();
export type VoucherSelection = z.infer<typeof voucherSelectionSchema>;
export const voucherCapabilitySchema = z.object({ enabled: z.literal(true) }).strict();
const operationSchema = <T extends z.ZodType>(receipt: T) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('succeeded'), receipt }).strict(),
    z.object({ status: z.literal('cancelled'), receipt: z.null() }).strict(),
  ]);
export const voucherOperationSchema = operationSchema(voucherReceiptSchema);
export const conversionOperationSchema = operationSchema(voucherConversionResultSchema);
export function readVoucherOperation(operatorId: string, operationId: string, signal: AbortSignal) {
  return request(
    `/api/v1/gift-voucher-operations/${operationId}`,
    { signal, operatorId },
    voucherOperationSchema,
  );
}
export function readConversionOperation(
  operatorId: string,
  operationId: string,
  signal: AbortSignal,
) {
  return request(
    `/api/v1/gift-voucher-operations/${operationId}`,
    { signal, operatorId },
    conversionOperationSchema,
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
/** Legacy `ajax-gift-voucher-check` (create_order.html:3786-3919). */
export function checkVoucher(
  operatorId: string,
  storeId: string,
  checkoutId: string,
  input: { voucherCode: string; giftCardPin?: string },
  signal: AbortSignal,
) {
  return request(
    `/api/v1/stores/${storeId}/checkout-sessions/${checkoutId}/voucher-checks`,
    { method: 'POST', body: JSON.stringify(input), signal, operatorId },
    voucherCheckResultSchema,
  );
}
/** Legacy `ajax-gift-voucher-convert` (create_order.html:3921-4060). */
export function createVoucherConversion(
  operatorId: string,
  storeId: string,
  checkoutId: string,
  input: { operationId: string; voucherCode: string; giftCardPin?: string },
  signal: AbortSignal,
) {
  return request(
    `/api/v1/stores/${storeId}/checkout-sessions/${checkoutId}/voucher-conversions`,
    { method: 'POST', body: JSON.stringify(input), signal, operatorId },
    voucherConversionResultSchema,
  );
}
export function cancelVoucherIntent(
  operatorId: string,
  operationId: string,
  body: { kind: 'issuance'; selectionId: string },
  signal: AbortSignal,
) {
  return request(
    `/api/v1/gift-voucher-operations/${operationId}/cancellations`,
    { method: 'POST', body: JSON.stringify(body), signal, operatorId },
    voucherOperationSchema,
  );
}
