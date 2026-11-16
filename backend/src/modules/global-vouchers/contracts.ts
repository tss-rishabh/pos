import { z } from 'zod';
import { identifier } from '../../domain/validation.js';

export const globalVoucherContract = 'pos-global-vouchers-v1' as const;
export const exactVoucherValueContract = 'pos-gift-voucher-exact-cents-v1' as const;
export const nonExpiringVoucherContract = 'pos-voucher-null-dates-gv-add-v1' as const;
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
export const voucherConversionSchema = z
  .object({
    operationId: z.uuid(),
    expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    voucherCode: z
      .string()
      .min(1)
      .max(25)
      .regex(/^[A-Za-z0-9]+$/),
    giftCardPin: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
const cents = z.string().regex(/^\d+\.\d{2}$/);
const wall = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
export const voucherReceiptSchema = z
  .object({
    operationId: z.uuid(),
    kind: z.enum(['issuance', 'conversion']),
    operatorId: identifier,
    customerId: identifier,
    voucherId: identifier,
    couponId: z.string().regex(/^(?:0|[1-9]\d*)$/),
    voucherCode: z.string().min(1).max(25),
    amount: cents,
    voucherHistoryId: identifier,
    moneyHistoryId: identifier.nullable(),
    walletBefore: cents.nullable(),
    walletAfter: cents.nullable(),
    nonExpiring: z.boolean(),
    createdAt: wall,
    contract: z.literal(globalVoucherContract),
    valueContract: z.enum(['pos-gift-voucher-integer-v1', exactVoucherValueContract]),
    checkoutId: z.uuid().nullable(),
    checkoutVersion: z.number().int().min(1).nullable(),
    status: z.literal('success'),
    message: z.string().max(400),
  })
  .strict();
export type VoucherIssuance = z.infer<typeof voucherIssuanceSchema>;
export type VoucherConversion = z.infer<typeof voucherConversionSchema>;
export type VoucherReceipt = z.infer<typeof voucherReceiptSchema>;
export const voucherCancellationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issuance'), selectionId: z.uuid() }).strict(),
  z.object({ kind: z.literal('conversion'), storeId: identifier, checkoutId: z.uuid() }).strict(),
]);
export type VoucherCancellation = z.infer<typeof voucherCancellationSchema>;
