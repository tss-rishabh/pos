import { z } from 'zod';
import { request } from '../../../api/client';

const identifier = z.string().regex(/^[1-9]\d{0,19}$/),
  money = z
    .string()
    .max(32)
    .regex(/^\d+\.\d{2}$/),
  time = z.number().int().safe().positive().max(8640000000000000);
export const importApprovalReasonSchema = z.enum([
  'late-recording',
  'historical-correction',
  'source-reconciliation',
]);
export const importApprovalReviewSchema = z
  .object({
    operationId: z.uuid(),
    kind: z.enum(['offline', 'shopify']),
    storeId: identifier,
    counterId: identifier,
    businessDate: z.iso.date(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    lineValue: money,
    lines: z
      .array(
        z
          .object({
            productId: identifier,
            quantity: z.number().int().min(1).max(999),
            unitPrice: money,
          })
          .strict(),
      )
      .min(1)
      .max(999),
  })
  .strict();
export const importFinancialApprovalSchema = z
  .object({
    id: z.uuid(),
    operationId: z.uuid(),
    actorId: identifier,
    storeId: identifier,
    counterId: identifier,
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    businessDate: z.iso.date(),
    approverId: identifier,
    reason: importApprovalReasonSchema,
    issuedAt: time,
    expiresAt: time,
    close: z
      .object({
        id: identifier,
        version: z.number().int().min(1).max(65535),
        status: z.enum(['CLOSED', 'STALE']),
      })
      .strict()
      .nullable(),
    status: z.enum(['approved', 'stale']),
  })
  .strict()
  .refine(
    (value) => value.expiresAt - value.issuedAt === 3600000,
    'The original approval expiry is inconsistent.',
  );
export const importApprovalResponseSchema = z
  .object({
    commandId: z.uuid().nullable(),
    review: importApprovalReviewSchema,
    approval: importFinancialApprovalSchema.nullable(),
  })
  .strict();
export type ImportApprovalReason = z.infer<typeof importApprovalReasonSchema>;
export type ImportApprovalResponse = z.infer<typeof importApprovalResponseSchema>;
export type ImportApprovalReview = z.infer<typeof importApprovalReviewSchema>;
export type ImportApprovalExpectation = Pick<
  ImportApprovalReview,
  'kind' | 'storeId' | 'counterId'
> & { businessDate: string | null };
export interface ImportApprovalScope {
  jobId: string;
  operationId: string;
  expected?: ImportApprovalExpectation;
}
export function checkedImportApproval(
  value: ImportApprovalResponse,
  operatorId: string,
  scope: ImportApprovalScope,
  commandId: string | null,
  reason?: ImportApprovalReason,
) {
  if (value.commandId !== commandId || value.review.operationId !== scope.operationId)
    throw new Error('The approval response belongs to a different saved request.');
  const expected = scope.expected,
    review = value.review,
    approval = value.approval;
  if (
    expected &&
    (review.kind !== expected.kind ||
      review.storeId !== expected.storeId ||
      review.counterId !== expected.counterId ||
      (expected.businessDate !== null && review.businessDate !== expected.businessDate))
  )
    throw new Error(
      'The original order review no longer matches this import row. Refresh its status.',
    );
  if (
    approval &&
    (approval.operationId !== scope.operationId ||
      approval.actorId !== operatorId ||
      approval.storeId !== review.storeId ||
      approval.counterId !== review.counterId ||
      approval.businessDate !== review.businessDate ||
      (commandId !== null && approval.approverId !== operatorId) ||
      (reason !== undefined && approval.reason !== reason))
  )
    throw new Error('The approval receipt does not confirm this original order and request.');
  return value;
}
const resource = (scope: ImportApprovalScope) =>
  '/api/v1/admin/order-imports/' +
  z.uuid().parse(scope.jobId) +
  '/orders/' +
  z.uuid().parse(scope.operationId) +
  '/approvals';
export async function readImportApproval(
  operatorId: string,
  scope: ImportApprovalScope,
  commandId: string | null = null,
  signal?: AbortSignal,
) {
  const value = await request(
    resource(scope) + (commandId === null ? '' : '/' + z.uuid().parse(commandId)),
    { operatorId, signal },
    importApprovalResponseSchema,
  );
  return checkedImportApproval(value, operatorId, scope, commandId);
}
export async function requestImportApproval(
  operatorId: string,
  scope: ImportApprovalScope,
  body: { commandId: string; reason: ImportApprovalReason },
  signal?: AbortSignal,
) {
  const input = z
    .object({ commandId: z.uuid(), reason: importApprovalReasonSchema })
    .strict()
    .parse(body);
  const value = await request(
    resource(scope),
    { method: 'POST', body: JSON.stringify(input), operatorId, signal },
    importApprovalResponseSchema,
  );
  checkedImportApproval(value, operatorId, scope, input.commandId, input.reason);
  if (!value.approval)
    throw new Error('The original approval request is unconfirmed. Refresh its saved receipt.');
  return value;
}
