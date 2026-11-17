import { z } from 'zod';
import { request } from '../../../api/client';
const identifier = z.string().regex(/^[1-9]\d{0,19}$/),
  money = z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const correctionScopeSchema = z.object({ jobId: z.uuid(), operationId: z.uuid() }).strict();
export type CorrectionScope = z.infer<typeof correctionScopeSchema>;
export const correctionInputSchema = z
  .object({
    id: z.uuid(),
    successorJobId: z.uuid(),
    successorOperationId: z.uuid(),
    reviewHash: hash,
    historicalTenderAmount: money,
    evidenceId: z.uuid(),
    confirmHistoricalTender: z.literal(true),
    lines: z
      .array(z.object({ row: z.number().int().min(2).max(50001), unitPrice: money }).strict())
      .min(1)
      .max(999),
  })
  .strict();
export type CorrectionInput = z.infer<typeof correctionInputSchema>;
export const correctionReceiptSchema = z
  .object({
    id: z.uuid(),
    originalJobId: z.uuid(),
    originalOperationId: z.uuid(),
    successorJobId: z.uuid(),
    successorOperationId: z.uuid(),
    managerId: identifier,
    originalLineValue: money,
    correctedLineValue: money,
    historicalTenderAmount: money,
    recordedAt: z.number().int().safe().positive(),
    requiresApproval: z.literal(true),
    financialExecution: z.literal('pending-approval'),
  })
  .strict();
export type CorrectionReceipt = z.infer<typeof correctionReceiptSchema>;
export const correctionFenceSchema = z
  .object({
    contract: z.literal('pos-import-correction-command-v1'),
    status: z.literal('not-created'),
    id: z.uuid(),
    originalJobId: z.uuid(),
    originalOperationId: z.uuid(),
    managerId: identifier,
    recordedAt: z.number().int().safe().positive(),
    noSuccessorQueued: z.literal(true),
    latePostsFenced: z.literal(true),
  })
  .strict();
export type CorrectionFence = z.infer<typeof correctionFenceSchema>;
export const correctionOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), receipt: correctionReceiptSchema }).strict(),
  correctionFenceSchema,
]);
export const correctionReviewSchema = z
  .object({
    jobId: z.uuid(),
    operationId: z.uuid(),
    enabled: z.boolean(),
    eligible: z.boolean(),
    blocker: z
      .enum([
        'ORDER_IMPORT_CORRECTION_DISABLED',
        'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
        'ORDER_IMPORT_CORRECTION_CALCULATION_REQUIRED',
        'ORDER_IMPORT_CORRECTION_PROFILE_UNQUALIFIED',
        'ORDER_IMPORT_CORRECTION_ALREADY_CREATED',
        'ORDER_IMPORT_CORRECTION_KIND_UNSUPPORTED',
        'ORDER_IMPORT_CORRECTION_DEPTH_LIMIT',
      ])
      .nullable(),
    reviewHash: hash.nullable(),
    original: z
      .object({
        sequence: z.number().int().min(1).max(50000),
        firstRow: z.number().int().min(2).max(50001),
        state: z.enum(['PENDING', 'STARTING', 'RECONCILING', 'IMPORTED', 'FAILED', 'CANCELLED']),
        errorCode: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
          .nullable(),
        kind: z.enum(['offline', 'shopify']),
        storeId: identifier,
        counterId: identifier,
        businessDateTime: z.string().max(30),
        payment: z.enum(['cash', 'manual-other', 'shopify']),
        lineValue: money,
        lines: z
          .array(
            z
              .object({
                row: z.number().int().min(2).max(50001),
                productId: identifier,
                quantity: z.number().int().min(1).max(999),
                unitPrice: money,
              })
              .strict(),
          )
          .min(1)
          .max(999),
      })
      .strict(),
    calculation: z
      .object({
        payable: money,
        calculationHash: hash,
        profileQualified: z.boolean(),
        profileCode: z
          .string()
          .regex(/^ORDER_IMPORT_[A-Z0-9_]{1,45}$/)
          .nullable(),
      })
      .strict()
      .nullable(),
    successor: correctionReceiptSchema.nullable(),
  })
  .strict();
export type CorrectionReview = z.infer<typeof correctionReviewSchema>;
const resource = (input: CorrectionScope) => {
  const scope = correctionScopeSchema.parse(input);
  return `/api/v1/admin/order-imports/${scope.jobId}/orders/${scope.operationId}/corrections`;
};
export async function readCorrectionReview(
  operatorId: string,
  scope: CorrectionScope,
  signal?: AbortSignal,
) {
  const value = await request(resource(scope), { operatorId, signal }, correctionReviewSchema);
  if (value.jobId !== scope.jobId || value.operationId !== scope.operationId)
    throw new Error('The review belongs to a different original import.');
  if (
    value.eligible &&
    (!value.enabled ||
      !value.reviewHash ||
      !value.calculation?.profileQualified ||
      value.blocker !== null)
  )
    throw new Error('The original source review is unconfirmed.');
  if (value.successor) checkedCorrectionReceipt(value.successor, operatorId, scope);
  return value;
}
export function checkedCorrectionReceipt(
  receipt: CorrectionReceipt,
  operatorId: string,
  scope: CorrectionScope,
  expected?: Pick<CorrectionInput, 'id' | 'successorJobId' | 'successorOperationId'>,
) {
  if (
    receipt.originalJobId !== scope.jobId ||
    receipt.originalOperationId !== scope.operationId ||
    receipt.managerId !== operatorId ||
    (expected &&
      (receipt.id !== expected.id ||
        receipt.successorJobId !== expected.successorJobId ||
        receipt.successorOperationId !== expected.successorOperationId))
  )
    throw new Error('The receipt does not confirm the original correction and successor.');
  return receipt;
}
export async function createCorrection(
  operatorId: string,
  scope: CorrectionScope,
  input: CorrectionInput,
  signal?: AbortSignal,
) {
  const body = correctionInputSchema.parse(input),
    receipt = await request(
      resource(scope),
      { method: 'POST', operatorId, signal, body: JSON.stringify(body) },
      correctionReceiptSchema,
    );
  checkedCorrectionReceipt(receipt, operatorId, scope, body);
  if (receipt.historicalTenderAmount !== body.historicalTenderAmount)
    throw new Error('The receipt does not confirm the reviewed historical tender.');
  return receipt;
}
export async function readCorrection(
  operatorId: string,
  scope: CorrectionScope,
  original: Pick<CorrectionInput, 'id' | 'successorJobId' | 'successorOperationId'>,
  signal?: AbortSignal,
) {
  const value = await request(
    resource(scope) + '/' + z.uuid().parse(original.id),
    { operatorId, signal },
    correctionOutcomeSchema,
  );
  if (value.status === 'accepted')
    checkedCorrectionReceipt(value.receipt, operatorId, scope, original);
  else if (
    value.id !== original.id ||
    value.originalJobId !== scope.jobId ||
    value.originalOperationId !== scope.operationId ||
    value.managerId !== operatorId
  )
    throw new Error('The fence does not confirm this original correction scope.');
  return value;
}
export function historicalTender(value: string) {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value))
    throw new Error('Enter the verified historical tender with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return money.parse(BigInt(whole!).toString() + '.' + fraction.padEnd(2, '0'));
}
