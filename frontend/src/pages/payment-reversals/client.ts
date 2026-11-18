import { z } from 'zod';
import { post, request } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,18}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  money = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
export const correctionInputSchema = z
  .object({
    operationId: z.uuid(),
    originalPaymentId: z.uuid(),
    counterId: id,
    snapshotHash: digest,
    cashReturnReceiptId: z.uuid(),
    returnedCash: money,
    confirmCashReturned: z.literal(true),
    confirmNoHandover: z.literal(true),
    reason: z.enum(['incorrect-payment-record', 'customer-payment-correction']),
  })
  .strict();
export const correctionReceiptSchema = z
  .object({
    id: z.uuid(),
    contract: z.literal('pos-payment-correction-v1'),
    status: z.literal('recorded'),
    orderId: id,
    storeId: id,
    counterId: id,
    operatorId: id,
    originalPaymentId: z.uuid(),
    originalPaymentHash: digest,
    transactionId: z.string().min(1).max(32),
    originalCash: money,
    originalCashReceived: money,
    originalFundingAt: z.string(),
    orderDate: z.iso.date(),
    returnedCash: money,
    cashReturnReceiptId: z.uuid(),
    reason: correctionInputSchema.shape.reason,
    recordedAt: z.string(),
    businessDate: z.iso.date(),
    headerHash: digest,
    lines: z
      .array(
        z
          .object({
            id,
            productId: id,
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
export const correctionContextSchema = z
  .object({
    orderId: id,
    storeId: id,
    counterId: id,
    eligible: z.boolean(),
    blocker: z.string().nullable(),
    snapshotHash: digest.nullable(),
    originalPaymentId: z.uuid().nullable(),
    returnedCash: money.nullable(),
    latest: correctionReceiptSchema.nullable(),
  })
  .strict();
export type CorrectionInput = z.infer<typeof correctionInputSchema>;
export type CorrectionReceipt = z.infer<typeof correctionReceiptSchema>;
export type CorrectionContext = z.infer<typeof correctionContextSchema>;
export interface CorrectionScope {
  ownerId: string;
  storeId: string;
  orderId: string;
}
const base = (scope: CorrectionScope) =>
  `/api/v1/stores/${encodeURIComponent(scope.storeId)}/orders/${encodeURIComponent(scope.orderId)}/payment-reversals`;
const key = (scope: CorrectionScope) =>
  `pos:payment-correction:v1:${scope.ownerId}:${scope.storeId}:${scope.orderId}`;
export function correctionIntent(scope: CorrectionScope): CorrectionInput | null {
  const raw = localStorage.getItem(key(scope));
  return raw === null ? null : correctionInputSchema.parse(JSON.parse(raw) as unknown);
}
export function persistCorrectionIntent(scope: CorrectionScope, input: CorrectionInput) {
  const value = correctionInputSchema.parse(input);
  localStorage.setItem(key(scope), JSON.stringify(value));
  // A blocked/quota storage implementation must not permit a money command.
  if (localStorage.getItem(key(scope)) !== JSON.stringify(value))
    throw new Error('The original correction reference could not be saved.');
}
export function clearCorrectionIntent(scope: CorrectionScope) {
  try {
    localStorage.removeItem(key(scope));
  } catch {
    /* confirmed server receipt remains authoritative */
  }
}
export function readCorrectionContext(scope: CorrectionScope, signal?: AbortSignal) {
  return request(base(scope), { operatorId: scope.ownerId, signal }, correctionContextSchema);
}
const cents = (value: string) => {
  const [whole, fraction = ''] = money.parse(value).split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
};
function matchingReceipt(scope: CorrectionScope, input: CorrectionInput, value: CorrectionReceipt) {
  if (
    value.id !== input.operationId ||
    value.originalPaymentId !== input.originalPaymentId ||
    value.orderId !== scope.orderId ||
    value.storeId !== scope.storeId ||
    value.operatorId !== scope.ownerId ||
    value.counterId !== input.counterId ||
    value.cashReturnReceiptId !== input.cashReturnReceiptId ||
    value.reason !== input.reason ||
    cents(value.returnedCash) !== cents(input.returnedCash)
  )
    throw new Error(
      'The correction receipt does not match the original request. Check the original reference.',
    );
  return value;
}
export async function readCorrection(
  scope: CorrectionScope,
  input: CorrectionInput,
  signal?: AbortSignal,
) {
  const value = await request(
    base(scope) + '/' + z.uuid().parse(input.operationId),
    { operatorId: scope.ownerId, signal },
    correctionReceiptSchema,
  );
  return matchingReceipt(scope, input, value);
}
export async function createCorrection(scope: CorrectionScope, input: CorrectionInput) {
  return matchingReceipt(
    scope,
    input,
    await post(
      base(scope),
      correctionInputSchema.parse(input),
      correctionReceiptSchema,
      scope.ownerId,
    ),
  );
}
