import { z } from 'zod';
import { captureOperatorScope, request } from '../../../api/client';
const id = z.string().regex(/^[1-9]\d{0,18}$/);
export const accountResult = z
  .object({
    id,
    operationId: z.uuid(),
    actorId: id,
    status: z.literal('success'),
    message: z.literal('Administrative account created.'),
  })
  .strict();
export type AccountResult = z.infer<typeof accountResult>;
export interface AccountInput {
  operationId: string;
  username: string;
  password: string;
  confirmation: string;
}
export function matchingAccount(result: AccountResult, ownerId: string, operationId: string) {
  if (result.actorId !== ownerId || result.operationId !== operationId)
    throw new Error(
      'The result belongs to a different account operation. Keep the original request for reconciliation.',
    );
  return result;
}
const base = '/api/v1/admin/operator-model-accounts';
export async function createAccount(ownerId: string, input: AccountInput, signal: AbortSignal) {
  return matchingAccount(
    await request(
      base,
      {
        operatorId: ownerId,
        method: 'POST',
        body: JSON.stringify(input),
        signal: AbortSignal.any([signal, captureOperatorScope(ownerId)]),
      },
      accountResult,
    ),
    ownerId,
    input.operationId,
  );
}
export async function readAccount(ownerId: string, operationId: string, signal: AbortSignal) {
  return matchingAccount(
    await request(
      base + '/' + z.uuid().parse(operationId),
      { operatorId: ownerId, signal: AbortSignal.any([signal, captureOperatorScope(ownerId)]) },
      accountResult,
    ),
    ownerId,
    operationId,
  );
}
export const accountCapabilities = z
  .object({
    canCreate: z.literal(true),
    defaults: z
      .object({
        role: z.literal(1),
        userType: z.literal(1),
        otpMethod: z.literal(2),
        active: z.literal(true),
        staff: z.literal(false),
        superuser: z.literal(false),
        mfa: z.literal(false),
        firstName: z.literal(''),
        lastName: z.literal(''),
        email: z.literal(''),
        phone: z.null(),
        contactEmail: z.null(),
        age: z.null(),
        gender: z.null(),
        lastLogin: z.null(),
      })
      .strict(),
  })
  .strict();
export const accountCapabilitiesPath = base + '/capabilities';
