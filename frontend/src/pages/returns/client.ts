import { z } from 'zod';
import { post, request } from '../../api/client';
const id = z.string().regex(/^[1-9]\d{0,19}$/);
export type ReverseKind = 'return' | 'exchange';
export const proofSchema = z.object({
  id: z.uuid(),
  orderId: id,
  sent: z.boolean(),
  expiresAt: z.number(),
  verifiedUntil: z.number().nullable(),
  pending: z.boolean(),
  deliveryStatus: z.enum(['pending', 'sent', 'uncertain', 'rejected']).nullable().optional(),
  requestOperationId: z.uuid().nullable().optional(),
  verifyOperationId: z.uuid().nullable().optional(),
  pendingOperationId: z.uuid().nullable().optional(),
  errorCode: z.string().nullable().optional(),
});
export const lineSchema = z.object({
  id,
  productId: id,
  name: z.string().nullable(),
  parentId: z.string(),
  quantity: id,
  status: z.string().nullable(),
  returnStatus: z.number().int(),
});
export const returnSchema = z.object({
  id: z.uuid(),
  storeId: id,
  orderId: id,
  lineId: id,
  kind: z.enum(['return', 'exchange']).optional(),
  phase: z.enum([
    'inbound-dispatching',
    'inbound-accepted',
    'refund-dispatching',
    'refund-confirmed',
    'old-item-restored',
    'replacement-dispatching',
    'replacement-rejected',
    'replacement-confirmed',
    'completed',
    'rejected',
    'uncertain',
  ]),
  uncertainStage: z.enum(['inbound', 'refund', 'replacement']).nullable(),
  creditNote: z.string().nullable(),
  returnAmount: z.string().nullable(),
  newOrderId: id.nullable().optional(),
  replacement: z
    .object({
      productId: id,
      size: z.string(),
      salespersonId: id,
      reasonId: id,
      subReasonId: id.nullable(),
    })
    .nullable()
    .optional(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReturnReceipt = z.infer<typeof returnSchema>;
export type ReturnProof = z.infer<typeof proofSchema>;
export type ReturnLine = z.infer<typeof lineSchema>;
export const recoverySchema = z
  .object({
    orderId: id,
    verificationId: z.uuid().nullable(),
    returnId: z.uuid().nullable(),
    kind: z.enum(['return', 'exchange']).optional(),
  })
  .strict();
export type ReturnRecovery = z.infer<typeof recoverySchema>;
const key = (ownerId: string, storeId: string, counterId: string) =>
  `souled-return:${ownerId}:${storeId}:${counterId}`;
export function loadRecovery(
  ownerId: string,
  storeId: string,
  counterId: string,
): ReturnRecovery | null {
  const raw = localStorage.getItem(key(ownerId, storeId, counterId));
  if (!raw) return null;
  try {
    return recoverySchema.parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
/** Persist only scoped operation identifiers. OTPs, comments and customer data remain in memory. */
export function saveRecovery(
  ownerId: string,
  storeId: string,
  counterId: string,
  value: ReturnRecovery | null,
) {
  if (value)
    localStorage.setItem(
      key(ownerId, storeId, counterId),
      JSON.stringify(recoverySchema.parse(value)),
    );
  else localStorage.removeItem(key(ownerId, storeId, counterId));
}
export const canContinue = (receipt: ReturnReceipt, kind: ReverseKind = receipt.kind || 'return') =>
  (kind === 'exchange'
    ? ['inbound-accepted', 'old-item-restored', 'replacement-confirmed']
    : ['inbound-accepted', 'refund-confirmed']
  ).includes(receipt.phase);
export const returnBase = (storeId: string) => `/api/v1/stores/${encodeURIComponent(storeId)}`;
export const readProof = (storeId: string, proofId: string, operatorId: string) =>
  request(
    `${returnBase(storeId)}/return-verifications/${encodeURIComponent(proofId)}`,
    { operatorId },
    proofSchema,
  );
export const readReturn = (storeId: string, returnId: string, operatorId: string) =>
  request(
    `${returnBase(storeId)}/returns/${encodeURIComponent(returnId)}`,
    { operatorId },
    returnSchema,
  );
export const continueReturn = (storeId: string, returnId: string, operatorId: string) =>
  post(
    `${returnBase(storeId)}/returns/${encodeURIComponent(returnId)}/continuations`,
    {},
    returnSchema,
    operatorId,
  );
export const readReverse = (
  storeId: string,
  operationId: string,
  kind: ReverseKind,
  operatorId: string,
) =>
  kind === 'return'
    ? readReturn(storeId, operationId, operatorId)
    : request(
        `${returnBase(storeId)}/exchanges/${encodeURIComponent(operationId)}`,
        { operatorId },
        returnSchema,
      );
export const continueReverse = (
  storeId: string,
  operationId: string,
  kind: ReverseKind,
  operatorId: string,
) =>
  kind === 'return'
    ? continueReturn(storeId, operationId, operatorId)
    : post(
        `${returnBase(storeId)}/exchanges/${encodeURIComponent(operationId)}/continuations`,
        {},
        returnSchema,
        operatorId,
      );
export const retryExchange = (
  storeId: string,
  operationId: string,
  salespersonId: string,
  operatorId: string,
) =>
  post(
    `${returnBase(storeId)}/exchanges/${encodeURIComponent(operationId)}/retries`,
    { salespersonId },
    returnSchema,
    operatorId,
  );
export const reconcileExchange = (storeId: string, operationId: string, operatorId: string) =>
  post(
    `${returnBase(storeId)}/exchanges/${encodeURIComponent(operationId)}/reconciliations`,
    {},
    returnSchema,
    operatorId,
  );
const wireId = z.union([id, z.number().int().positive().safe()]).transform(String);
export const exchangeReasonsSchema = z.object({
  data: z.array(
    z.object({
      id: wireId,
      reason: z.string(),
      sub_reason: z
        .array(z.object({ id: wireId, sub_reason: z.string() }))
        .optional()
        .default([]),
    }),
  ),
});
export const exchangeSizesSchema = z.object({
  data: z.array(z.object({ prod_id: id, size: z.string().nullable(), stock: z.number().int() })),
});
export const salespeopleSchema = z.object({
  data: z.array(
    z.object({
      id,
      name: z.string(),
    }),
  ),
  nextCursor: id.nullable(),
});
export type Salesperson = z.infer<typeof salespeopleSchema>['data'][number];
