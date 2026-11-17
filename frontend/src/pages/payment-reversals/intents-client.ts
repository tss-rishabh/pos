import { z } from 'zod';
import { post, request } from '../../api/client';
import { correctionInputSchema, correctionReceiptSchema, type CorrectionScope } from './client';
import {
  prepareReturnSchema,
  attestReturnSchema,
  cancelReturnSchema,
  cashReturnViewSchema,
  cashReturnReplySchema,
  claimViewSchema,
  returnJournalSchema,
  type CashReturnView,
  type ReturnJournal,
} from './intent-contracts';
export * from './intent-contracts';
const pathId = z.string().regex(/^[1-9]\d{0,18}$/);
const key = (scope: CorrectionScope) =>
  `pos:cash-return:v1:${scope.ownerId}:${scope.storeId}:${scope.orderId}`;
export function returnJournal(scope: CorrectionScope) {
  const raw = localStorage.getItem(key(scope));
  return raw === null ? null : returnJournalSchema.parse(JSON.parse(raw) as unknown);
}
export function saveReturnJournal(scope: CorrectionScope, raw: ReturnJournal) {
  const value = JSON.stringify(returnJournalSchema.parse(raw));
  localStorage.setItem(key(scope), value);
  if (localStorage.getItem(key(scope)) !== value)
    throw new Error('Save the original cash-return reference before continuing.');
}
export function removeReturnJournal(scope: CorrectionScope) {
  try {
    localStorage.removeItem(key(scope));
  } catch {
    /* server evidence remains authoritative */
  }
}
const base = (scope: CorrectionScope) =>
  `/api/v1/stores/${pathId.parse(scope.storeId)}/orders/${pathId.parse(scope.orderId)}/cash-return-intents`;
const args = (scope: CorrectionScope, signal?: AbortSignal) => ({
  operatorId: scope.ownerId,
  signal,
});
function bound(scope: CorrectionScope, value: CashReturnView) {
  if (value.storeId !== scope.storeId || value.orderId !== scope.orderId)
    throw new Error('The cash-return evidence belongs to another order.');
  return value;
}
export async function getReturn(scope: CorrectionScope, id: string, signal?: AbortSignal) {
  return bound(
    scope,
    await request(
      base(scope) + '/' + z.uuid().parse(id),
      args(scope, signal),
      cashReturnViewSchema,
    ),
  );
}
export async function getReturnOperation(
  scope: CorrectionScope,
  id: string,
  operationId: string,
  signal?: AbortSignal,
) {
  const r = await request(
    base(scope) + '/' + z.uuid().parse(id) + '/operations/' + z.uuid().parse(operationId),
    args(scope, signal),
    cashReturnReplySchema,
  );
  bound(scope, r.intent);
  if (r.newlyArmed) throw new Error('Recovery cannot authorize another cash handback.');
  return r;
}
export async function prepareReturn(
  scope: CorrectionScope,
  input: z.infer<typeof prepareReturnSchema>,
) {
  const r = await post(
    base(scope),
    prepareReturnSchema.parse(input),
    cashReturnReplySchema,
    scope.ownerId,
  );
  bound(scope, r.intent);
  return r;
}
export async function armReturn(scope: CorrectionScope, id: string, operationId: string) {
  const r = await post(
    base(scope) + '/' + z.uuid().parse(id) + '/armings',
    { operationId: z.uuid().parse(operationId) },
    cashReturnReplySchema,
    scope.ownerId,
  );
  bound(scope, r.intent);
  return r;
}
export async function attestReturn(
  scope: CorrectionScope,
  id: string,
  input: z.infer<typeof attestReturnSchema>,
) {
  const r = await post(
    base(scope) + '/' + z.uuid().parse(id) + '/attestations',
    attestReturnSchema.parse(input),
    cashReturnReplySchema,
    scope.ownerId,
  );
  bound(scope, r.intent);
  return r;
}
export async function cancelReturn(
  scope: CorrectionScope,
  id: string,
  input: z.infer<typeof cancelReturnSchema>,
) {
  const r = await post(
    base(scope) + '/' + z.uuid().parse(id) + '/cancellations',
    cancelReturnSchema.parse(input),
    cashReturnReplySchema,
    scope.ownerId,
  );
  bound(scope, r.intent);
  return r;
}
export async function resolveReturn(scope: CorrectionScope, id: string, operationId: string) {
  return post(
    base(scope) + '/' + z.uuid().parse(id) + '/reconciliations',
    { operationId: z.uuid().parse(operationId) },
    correctionReceiptSchema,
    scope.ownerId,
  );
}
export async function pendingReturns(
  ownerId: string,
  storeId: string,
  after?: string,
  signal?: AbortSignal,
) {
  const suffix = after ? '?after=' + z.uuid().parse(after) : '';
  return request(
    `/api/v1/stores/${pathId.parse(storeId)}/cash-return-intents${suffix}`,
    { operatorId: ownerId, signal },
    z.object({ data: z.array(cashReturnViewSchema), nextCursor: z.uuid().nullable() }).strict(),
  );
}
export async function pendingClaims(
  ownerId: string,
  storeId: string,
  after?: string,
  signal?: AbortSignal,
) {
  const suffix = after ? '?after=' + z.uuid().parse(after) : '';
  return request(
    `/api/v1/stores/${pathId.parse(storeId)}/cash-return-claims${suffix}`,
    { operatorId: ownerId, signal },
    z.object({ data: z.array(claimViewSchema), nextCursor: z.uuid().nullable() }).strict(),
  );
}
export const retainedClaimInputSchema = z
  .object({
    original: correctionInputSchema.omit({ intentId: true, claimId: true }),
    returnedBy: z.string().regex(/^[1-9]\d{0,18}$/),
    returnedAt: z.iso.datetime({ precision: 3 }),
    confirmAlreadyReturned: z.literal(true),
    evidenceId: z.uuid(),
  })
  .strict();
export type RetainedClaimInput = z.infer<typeof retainedClaimInputSchema>;
const claimBase = (scope: CorrectionScope) =>
  `/api/v1/stores/${pathId.parse(scope.storeId)}/orders/${pathId.parse(scope.orderId)}/cash-return-claims`;
export function retainClaim(scope: CorrectionScope, input: RetainedClaimInput) {
  return post(
    claimBase(scope),
    retainedClaimInputSchema.parse(input),
    claimViewSchema,
    scope.ownerId,
  );
}
export function getClaim(scope: CorrectionScope, id: string, signal?: AbortSignal) {
  return request(claimBase(scope) + '/' + z.uuid().parse(id), args(scope, signal), claimViewSchema);
}
export function resolveClaim(scope: CorrectionScope, id: string) {
  return post(
    claimBase(scope) + '/' + z.uuid().parse(id) + '/reconciliations',
    { operationId: z.uuid().parse(id) },
    correctionReceiptSchema,
    scope.ownerId,
  );
}
