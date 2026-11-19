import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

export const voucherAmount = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
  .refine(
    (value) => Number(value) > 0 && Number(value) <= 99999999,
    'Enter a positive amount up to 99999999.',
  );
export const voucherLookupSchema = z.object({ email: z.email().max(96) }).strict();
export const voucherSelectionSchema = z
  .object({
    selectionId: z.uuid(),
    customerId: identifier,
    name: z.string().max(130),
    expiresAt: z.number().int().safe(),
  })
  .strict();
export const voucherIssuanceSchema = z
  .object({
    operationId: z.uuid(),
    selectionId: z.uuid(),
    amount: voucherAmount,
  })
  .strict();
const voucherCode = z
  .string()
  .trim()
  .min(1)
  .max(25)
  .regex(/^[A-Za-z0-9]+$/);
/** create_order.html:3824-3910 GC PIN dialog: 6 digits (`'mask': '999999'`). */
const giftCardPin = z.string().regex(/^\d{6}$/);
/** AjaxGiftVoucherCheck (order/views.py:4518-4546). */
export const voucherCheckSchema = z
  .object({ voucherCode, giftCardPin: giftCardPin.optional() })
  .strict();
/** AjaxGiftVoucherConvert (order/views.py:4548-4579). */
export const voucherConversionSchema = z
  .object({ operationId: z.uuid(), voucherCode, giftCardPin: giftCardPin.optional() })
  .strict();
const cents = z.string().regex(/^\d+\.\d{2}$/);
const wall = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
export const voucherReceiptSchema = z
  .object({
    operationId: z.uuid(),
    kind: z.literal('issuance'),
    operatorId: identifier,
    customerId: identifier,
    voucherId: identifier,
    couponId: z.string().regex(/^(?:0|[1-9]\d*)$/),
    voucherCode: z.string().min(1).max(25),
    amount: cents,
    voucherHistoryId: identifier,
    nonExpiring: z.literal(true),
    createdAt: wall,
    status: z.literal('success'),
    message: z.string().max(400),
  })
  .strict();
/** Upstream `gift_voucher_check` balance/validity as the legacy dialog shows it. */
export const voucherCheckResultSchema = z
  .object({
    voucherCode: z.string().min(1).max(25),
    voucherValue: z.string().max(32),
    validity: z.string().max(32).nullable(),
    nonExpiring: z.boolean(),
    pinUsed: z.boolean(),
  })
  .strict();
export const voucherConversionResultSchema = z
  .object({
    operationId: z.uuid(),
    kind: z.literal('conversion'),
    operatorId: identifier,
    customerId: identifier,
    storeId: identifier,
    checkoutId: z.uuid(),
    voucherCode: z.string().min(1).max(25),
    pinUsed: z.boolean(),
    status: z.literal('success'),
    message: z.string().max(400),
  })
  .strict();
export type VoucherIssuance = z.infer<typeof voucherIssuanceSchema>;
export type VoucherCheck = z.infer<typeof voucherCheckSchema>;
export type VoucherConversion = z.infer<typeof voucherConversionSchema>;
export type VoucherReceipt = z.infer<typeof voucherReceiptSchema>;
export type VoucherCheckResult = z.infer<typeof voucherCheckResultSchema>;
export type VoucherConversionResult = z.infer<typeof voucherConversionResultSchema>;
export const voucherCancellationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issuance'), selectionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('conversion'), storeId: identifier, checkoutId: z.uuid() }).strict(),
]);
export type VoucherCancellation = z.infer<typeof voucherCancellationSchema>;
