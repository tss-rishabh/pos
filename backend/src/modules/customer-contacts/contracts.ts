import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { contactStatuses } from './schema.js';

export const contactChangeContract = 'pos-customer-contact-v1';
export const contactEffectsContract = 'pos-customer-contact-effects-v1';
export const contactStage = z.enum(['current', 'new']);
export const contactKind = z.enum(['telephone', 'email']);
const version = z.number().int().nonnegative().refine(Number.isSafeInteger),
  fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const contactScope = z.object({ storeId: identifier, checkoutId: z.uuid() }).strict();
export const requestContactChange = z
  .object({
    operationId: z.uuid(),
    checkoutVersion: version,
    contactFingerprint: fingerprint,
    kind: contactKind,
    value: z.string().trim().min(1).max(96),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.kind === 'telephone' && !/^[6-9]\d{9}$/.test(input.value))
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Enter a valid 10-digit Indian mobile number.',
      });
    if (input.kind === 'email' && !z.email().max(96).safeParse(input.value).success)
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Enter a valid email address within 96 characters.',
      });
  });
export const verifyContactChange = z
  .object({
    operationId: z.uuid(),
    version,
    stage: contactStage,
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();
export const resendContactChange = z.object({ operationId: z.uuid(), version }).strict();
export const commitContactChange = z
  .object({ operationId: z.uuid(), version, checkoutVersion: version })
  .strict();
export const cancelContactChange = resendContactChange;
export const contactEnvelope = z
  .object({
    purpose: z.literal(contactChangeContract),
    id: z.uuid(),
    kind: contactKind,
    value: z.string().min(1).max(96),
    current: z
      .object({ channel: z.enum(['sms', 'email']), destination: z.string().min(1).max(96) })
      .strict(),
    oldEmail: z.string().max(96),
    oldTelephone: z.string().max(32),
  })
  .strict();
export const contactOtpPayload = z
  .object({
    purpose: z.literal('customer-contact-otp-v1'),
    challengeId: z.uuid(),
    stage: contactStage,
    channel: z.enum(['sms', 'email']),
    destination: z.string().min(1).max(96),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();
export const contactEffectPayload = z
  .object({
    contract: z.literal(contactEffectsContract),
    operationId: z.uuid(),
    challengeId: z.uuid(),
    operatorId: identifier,
    customerId: identifier,
    storeId: identifier,
    checkoutId: z.uuid(),
    kind: contactKind,
    oldEmail: z.string().max(96),
    oldTelephone: z.string().max(32),
    newValue: z.string().min(1).max(96),
    refundRemails: z
      .array(z.object({ orderId: identifier, refundRequestId: identifier }).strict())
      .max(1000),
    requestId: z.string().max(128).nullable(),
  })
  .strict();
export type ContactEffectPayload = z.infer<typeof contactEffectPayload>;
export interface CustomerContactDelivery {
  assertReady(channel: 'sms' | 'email'): void;
  sendOtp(
    id: string,
    input: z.infer<typeof contactOtpPayload>,
    signal: AbortSignal,
  ): Promise<'accepted' | 'rejected' | 'uncertain'>;
  assertEffectsReady(): void;
  sourceEffects(
    id: string,
    input: ContactEffectPayload,
    signal: AbortSignal,
  ): Promise<'accepted' | 'rejected' | 'uncertain'>;
}
export const publicContactChallenge = z
  .object({
    id: z.uuid(),
    kind: contactKind,
    stage: contactStage,
    status: z.enum(contactStatuses),
    version,
    customerId: identifier,
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
    customerId: identifier,
    checkoutVersion: version,
    contactFingerprint: fingerprint.nullable(),
    enabled: z.boolean(),
    addableKinds: z.array(contactKind).max(2),
    activeChallenge: publicContactChallenge.nullable(),
    pendingElsewhere: z.boolean(),
  })
  .strict();
export const contactMutationReceipt = z
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
export const contactMutationResponse = z
  .object({ challenge: publicContactChallenge, receipt: contactMutationReceipt })
  .strict();
export type PublicContactChallenge = z.infer<typeof publicContactChallenge>;
