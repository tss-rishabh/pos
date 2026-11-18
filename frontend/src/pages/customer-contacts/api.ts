import { z } from 'zod';
import { captureOperatorScope, request } from '../../api/client';
import { requireCachedOperatorSession } from '../../offline/operator-session';

const version = z.number().int().nonnegative().safe(),
  id = z.string().regex(/^[1-9]\d{0,18}$/);
export const contactKind = z.enum(['telephone', 'email']);
export const contactChallenge = z
  .object({
    id: z.uuid(),
    kind: contactKind,
    stage: z.enum(['current', 'new']),
    status: z.enum([
      'PENDING_CURRENT',
      'PENDING_NEW',
      'READY',
      'COMMITTING',
      'COMMITTED',
      'CANCELLED',
      'EXPIRED',
      'LOCKED',
      'UNCERTAIN',
    ]),
    version,
    customerId: id,
    value: z.string().max(96),
    currentDestination: z.string().max(120),
    expiresAt: version,
    codeExpiresAt: version,
    retryAt: version,
    attemptsRemaining: z.number().int().min(0).max(5),
    delivery: z
      .enum(['PENDING', 'SENDING', 'DELIVERED', 'UNCERTAIN', 'REJECTED', 'CANCELLED'])
      .nullable(),
  })
  .strict();
export const contactWorkspace = z
  .object({
    customerId: id,
    checkoutVersion: version,
    contactFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    enabled: z.boolean(),
    addableKinds: z.array(contactKind).max(2),
    activeChallenge: contactChallenge.nullable(),
    pendingElsewhere: z.boolean(),
  })
  .strict();
export const contactReceipt = z
  .object({
    id: z.uuid(),
    challengeId: z.uuid(),
    status: z.enum(['success', 'error']),
    message: z.string().max(400),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,96}$/)
      .optional(),
    errorStatus: z
      .union([z.literal(400), z.literal(403), z.literal(409), z.literal(422), z.literal(429)])
      .optional(),
    checkoutVersion: version.optional(),
  })
  .strict();
export const contactResponse = z
  .object({ challenge: contactChallenge, receipt: contactReceipt })
  .strict();
export const contactCreateInput = z
  .object({
    operationId: z.uuid(),
    checkoutVersion: version,
    contactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    kind: contactKind,
    value: z.string().trim().min(1).max(96),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.kind === 'telephone'
        ? !/^[6-9]\d{9}$/.test(input.value)
        : !z.email().max(96).safeParse(input.value).success
    )
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Enter a valid mobile number or email address.',
      });
  });
export const contactVerifyInput = z
  .object({
    operationId: z.uuid(),
    version,
    stage: z.enum(['current', 'new']),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();
export const contactVersionInput = z.object({ operationId: z.uuid(), version }).strict();
export const contactCommitInput = contactVersionInput.extend({ checkoutVersion: version }).strict();
export type ContactChallenge = z.infer<typeof contactChallenge>;
export type ContactWorkspace = z.infer<typeof contactWorkspace>;
export interface CustomerContactScope {
  operatorId: string;
  storeId: string;
  checkoutId: string;
  customerId: string;
}
export type ContactIntent =
  | { action: 'create'; input: z.infer<typeof contactCreateInput> }
  | { action: 'verify'; challengeId: string; input: z.infer<typeof contactVerifyInput> }
  | { action: 'commit'; challengeId: string; input: z.infer<typeof contactCommitInput> }
  | {
      action: 'resend' | 'cancel';
      challengeId: string;
      input: z.infer<typeof contactVersionInput>;
    };
const base = (scope: CustomerContactScope) =>
  `/api/v1/stores/${encodeURIComponent(scope.storeId)}/checkout-sessions/${encodeURIComponent(scope.checkoutId)}`;
async function privateRequest<T>(
  scope: CustomerContactScope,
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  signal: AbortSignal,
) {
  const owner = captureOperatorScope(scope.operatorId),
    combined = AbortSignal.any([owner, signal, AbortSignal.timeout(12000)]);
  await requireCachedOperatorSession(scope.operatorId, scope.storeId, combined);
  const value = await request(
    path,
    { ...init, signal: combined, operatorId: scope.operatorId, cache: 'no-store' },
    schema,
  );
  combined.throwIfAborted();
  await requireCachedOperatorSession(scope.operatorId, scope.storeId, combined);
  return value;
}
export async function readContactWorkspace(scope: CustomerContactScope, signal: AbortSignal) {
  const result = await privateRequest(
    scope,
    base(scope) + '/customer-contacts',
    {},
    contactWorkspace,
    signal,
  );
  if (result.customerId !== scope.customerId)
    throw new Error('The customer attached to this sale changed. Refresh the sale.');
  return result;
}
export async function readContactChallenge(
  scope: CustomerContactScope,
  challengeId: string,
  signal: AbortSignal,
) {
  const result = await privateRequest(
    scope,
    base(scope) + '/customer-contact-challenges/' + encodeURIComponent(z.uuid().parse(challengeId)),
    {},
    contactChallenge,
    signal,
  );
  if (result.id !== challengeId || result.customerId !== scope.customerId)
    throw new Error('The customer contact proof changed. Refresh the sale.');
  return result;
}
export async function readContactOperation(
  scope: CustomerContactScope,
  intent: Exclude<ContactIntent, { action: 'create' }>,
  signal: AbortSignal,
) {
  const result = await privateRequest(
    scope,
    base(scope) +
      '/customer-contact-challenges/' +
      encodeURIComponent(intent.challengeId) +
      '/operations/' +
      encodeURIComponent(intent.input.operationId),
    {},
    contactResponse,
    signal,
  );
  if (
    result.challenge.id !== intent.challengeId ||
    result.challenge.customerId !== scope.customerId ||
    result.receipt.id !== intent.input.operationId ||
    result.receipt.challengeId !== intent.challengeId
  )
    throw new Error('The saved contact operation could not be matched.');
  return result;
}
export async function sendContactIntent(
  scope: CustomerContactScope,
  intent: ContactIntent,
  signal: AbortSignal,
) {
  if (intent.action === 'create') {
    const input = contactCreateInput.parse(intent.input),
      result = await privateRequest(
        scope,
        base(scope) + '/customer-contact-challenges',
        { method: 'POST', body: JSON.stringify(input) },
        contactChallenge,
        signal,
      );
    if (result.id !== input.operationId || result.customerId !== scope.customerId)
      throw new Error('The contact request could not be matched.');
    return { challenge: result, receipt: null };
  }
  const segment = {
      verify: 'verifications',
      commit: 'commits',
      resend: 'resends',
      cancel: 'cancellations',
    }[intent.action],
    input =
      intent.action === 'verify'
        ? contactVerifyInput.parse(intent.input)
        : intent.action === 'commit'
          ? contactCommitInput.parse(intent.input)
          : contactVersionInput.parse(intent.input);
  const result = await privateRequest(
    scope,
    base(scope) +
      '/customer-contact-challenges/' +
      encodeURIComponent(z.uuid().parse(intent.challengeId)) +
      '/' +
      segment,
    { method: 'POST', body: JSON.stringify(input) },
    contactResponse,
    signal,
  );
  if (
    result.challenge.id !== intent.challengeId ||
    result.challenge.customerId !== scope.customerId ||
    result.receipt.id !== input.operationId ||
    result.receipt.challengeId !== intent.challengeId
  )
    throw new Error('The contact operation could not be matched.');
  return result;
}
