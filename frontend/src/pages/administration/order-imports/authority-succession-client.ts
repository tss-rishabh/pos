import { z } from 'zod';
import { request, post } from '../../../api/client';
const id = z.string().regex(/^[1-9]\d{0,18}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().positive().safe(),
  scope = z.object({ jobId: z.uuid(), operationId: z.uuid() }).strict(),
  ref = z.object({ id: z.uuid(), sequence: z.number().int().min(1).max(100), hash }).strict();
export type AuthorityRecoveryScope = z.infer<typeof scope>;
export const authorityReasonSchema = z.enum([
  'actor-changed',
  'contact-changed',
  'authority-recovery',
]);
export const authorityGrantSchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int().positive(),
    jobId: z.uuid(),
    operationId: z.uuid(),
    orderId: id,
    managerId: id,
    issuedAt: time,
    expiresAt: time,
    reviewHash: hash,
  })
  .strict();
export type AuthorityGrant = z.infer<typeof authorityGrantSchema>;
export const authorityReviewSchema = z
  .object({
    contract: z.literal('pos-import-authority-succession-v1'),
    jobId: z.uuid(),
    operationId: z.uuid(),
    orderId: id,
    storeId: id,
    counterId: id,
    originalActorId: id,
    currentManagerId: id,
    businessDate: z.iso.date(),
    payable: z.string().regex(/^\d{1,10}\.\d{2}$/),
    kind: z.enum(['offline', 'shopify']),
    status: z.enum(['ready', 'blocked', 'completed']),
    code: z
      .string()
      .regex(/^ORDER_IMPORT_[A-Z0-9_]{1,45}$/)
      .nullable(),
    next: z.enum(['confirmation', 'settlement', 'publication']).nullable(),
    head: ref.nullable(),
    reviewHash: hash,
    grant: authorityGrantSchema.nullable(),
  })
  .strict();
export type AuthorityReview = z.infer<typeof authorityReviewSchema>;
export const authorityContinuationSchema = z
  .object({
    commandId: z.uuid(),
    grantId: z.uuid(),
    jobId: z.uuid(),
    operationId: z.uuid(),
    status: z.enum(['started', 'unknown', 'completed']),
    stage: z.enum(['confirmation', 'settlement', 'publication']).nullable(),
    orderId: id,
    result: z
      .object({
        operationId: z.uuid(),
        orderId: id,
        receiptId: z.uuid(),
        businessDate: z.iso.date(),
        projectionHash: hash,
      })
      .strict()
      .nullable(),
    createdAt: time,
    updatedAt: time,
  })
  .strict();
export type AuthorityContinuation = z.infer<typeof authorityContinuationSchema>;
const base = (input: AuthorityRecoveryScope) => {
  const s = scope.parse(input);
  return (
    '/api/v1/admin/order-imports/' + s.jobId + '/orders/' + s.operationId + '/authority-successions'
  );
};
function checked<T extends AuthorityRecoveryScope>(value: T, input: AuthorityRecoveryScope) {
  if (value.jobId !== input.jobId || value.operationId !== input.operationId)
    throw Error('The recovery reply belongs to another original order.');
  return value;
}
export async function reviewImportAuthority(actorId: string, input: AuthorityRecoveryScope) {
  const value = checked(
    await request(base(input), { operatorId: actorId }, authorityReviewSchema),
    input,
  );
  if (value.currentManagerId !== actorId)
    throw Error('The authority review belongs to another manager.');
  return value;
}
export async function approveImportAuthority(
  actorId: string,
  input: AuthorityRecoveryScope,
  body: { commandId: string; reviewHash: string; reason: z.infer<typeof authorityReasonSchema> },
) {
  const value = checked(await post(base(input), body, authorityGrantSchema, actorId), input);
  if (value.id !== body.commandId || value.managerId !== actorId)
    throw Error('The approval reply does not match the saved action.');
  return value;
}
export async function readImportAuthorityApproval(
  actorId: string,
  input: AuthorityRecoveryScope,
  commandId: string,
) {
  const value = await request(
    base(input) + '/' + z.uuid().parse(commandId),
    { operatorId: actorId },
    z.object({ data: authorityGrantSchema.nullable() }).strict(),
  );
  if (!value.data) return null;
  const data = checked(value.data, input);
  if (data.id !== commandId) throw Error('The approval reply does not match the saved action.');
  return data;
}
export async function continueImportAuthority(
  actorId: string,
  input: AuthorityRecoveryScope,
  body: { commandId: string; grantId: string },
) {
  const value = checked(
    await post(base(input) + '/continuations', body, authorityContinuationSchema, actorId),
    input,
  );
  if (value.commandId !== body.commandId || value.grantId !== body.grantId)
    throw Error('The continuation reply does not match the saved action.');
  return value;
}
export async function readImportAuthorityContinuation(
  actorId: string,
  input: AuthorityRecoveryScope,
  commandId: string,
) {
  const value = await request(
    base(input) + '/continuations/' + z.uuid().parse(commandId),
    { operatorId: actorId },
    z.object({ data: authorityContinuationSchema.nullable() }).strict(),
  );
  if (!value.data) return null;
  const data = checked(value.data, input);
  if (data.commandId !== commandId)
    throw Error('The continuation reply does not match the saved action.');
  return data;
}
