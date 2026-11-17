import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { amountSchema } from '../contracts.js';

export const cashReturnIntentContract = 'pos-cash-return-intent-v1';
export const cashReturnReason = z.enum(['incorrect-payment-record', 'customer-payment-correction']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const cashReturnPrepareInput = z
  .object({
    operationId: z.uuid(),
    correctionId: z.uuid(),
    cashReturnReceiptId: z.uuid(),
    originalPaymentId: z.uuid(),
    snapshotHash: hash,
    counterId: identifier,
    returnedCash: amountSchema,
    reason: cashReturnReason,
    confirmNoHandover: z.literal(true),
  })
  .strict()
  .refine(
    (value) =>
      new Set([value.operationId, value.correctionId, value.cashReturnReceiptId]).size === 3,
    'Use separate original operation references.',
  );
export type CashReturnPrepareInput = z.infer<typeof cashReturnPrepareInput>;
export const cashReturnAttestInput = z
  .object({
    operationId: z.uuid(),
    returnedAt: z.iso.datetime({ precision: 3 }),
    confirmAlreadyReturned: z.literal(true),
    confirmNoHandover: z.literal(true),
    basis: z.enum(['own-return', 'reviewed-original-return']),
    evidenceId: z.uuid(),
  })
  .strict();
export type CashReturnAttestInput = z.infer<typeof cashReturnAttestInput>;
export const cashReturnCancelInput = z
  .object({
    operationId: z.uuid(),
    confirmCashNotReturned: z.literal(true),
    evidenceId: z.uuid(),
    reason: z.enum(['customer-retained-payment', 'preparation-error', 'correction-not-needed']),
  })
  .strict();
export const cashReturnReceiptEvidence = z
  .object({
    intentId: z.uuid(),
    attestationId: z.uuid(),
    returnedBy: identifier,
    attestedBy: identifier,
    returnedInstant: z.iso.datetime({ precision: 3 }),
    returnedAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    businessDate: z.iso.date(),
    businessTimezone: z.string().min(1).max(100),
    preparedHash: hash,
    origin: z.literal('retained-device-claim').optional(),
  })
  .strict();
export const cashReturnIntentBody = z
  .object({
    id: z.uuid(),
    contract: z.literal(cashReturnIntentContract),
    revision: z.number().int().safe().positive(),
    orderId: identifier,
    storeId: identifier,
    counterId: identifier,
    businessTimezone: z.string().min(1).max(100),
    preparedBy: identifier,
    preparedAt: z.iso.datetime({ precision: 3 }),
    preparedSessionHash: hash,
    prepare: cashReturnPrepareInput,
    preparedHash: hash,
    originalPaymentHash: hash,
    orderDate: z.iso.date(),
    originalFundingAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    phase: z.enum(['PREPARED', 'RETURN_PENDING', 'ATTESTED', 'RECORDED', 'CANCELLED']),
    armed: z
      .object({
        operationId: z.uuid(),
        actorId: identifier,
        sessionHash: hash,
        at: z.iso.datetime({ precision: 3 }),
      })
      .strict()
      .nullable(),
    attestation: z
      .object({
        operationId: z.uuid(),
        actorId: identifier,
        sessionHash: hash,
        at: z.iso.datetime({ precision: 3 }),
        input: cashReturnAttestInput,
        evidence: cashReturnReceiptEvidence,
      })
      .strict()
      .nullable(),
    cancellation: z
      .object({
        operationId: z.uuid(),
        actorId: identifier,
        at: z.iso.datetime({ precision: 3 }),
        input: cashReturnCancelInput,
      })
      .strict()
      .nullable(),
    resolution: z
      .object({
        actorId: identifier,
        at: z.iso.datetime({ precision: 3 }),
        correctionId: z.uuid(),
        receiptHash: hash,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CashReturnIntentBody = z.infer<typeof cashReturnIntentBody>;
export type CashReturnAction = 'prepare' | 'arm' | 'attest' | 'cancel' | 'resolve';
export const cashReturnControlSchema = z
  .object({
    storeId: identifier,
    revision: z.string().regex(/^(0|[1-9]\d{0,19})$/),
    manifestHash: hash,
    unresolvedCount: z.number().int().safe().nonnegative(),
  })
  .strict();
export type CashReturnControl = z.infer<typeof cashReturnControlSchema>;
export const cashReturnPublicIntentSchema = z
  .object({
    id: z.uuid(),
    contract: z.literal(cashReturnIntentContract),
    revision: z.number().int().safe().positive(),
    phase: cashReturnIntentBody.shape.phase,
    orderId: identifier,
    storeId: identifier,
    counterId: identifier,
    preparedBy: identifier,
    preparedAt: z.iso.datetime({ precision: 3 }),
    correctionId: z.uuid(),
    cashReturnReceiptId: z.uuid(),
    originalPaymentId: z.uuid(),
    returnedCash: amountSchema,
    reason: cashReturnReason,
    armed: z
      .object({ actorId: identifier, at: z.iso.datetime({ precision: 3 }) })
      .strict()
      .nullable(),
    attestation: z
      .object({
        actorId: identifier,
        at: z.iso.datetime({ precision: 3 }),
        evidenceId: z.uuid(),
        evidence: cashReturnReceiptEvidence,
      })
      .strict()
      .nullable(),
    cancellation: z
      .object({
        actorId: identifier,
        at: z.iso.datetime({ precision: 3 }),
        reason: cashReturnCancelInput.shape.reason,
        evidenceId: z.uuid(),
      })
      .strict()
      .nullable(),
    resolution: z
      .object({ actorId: identifier, at: z.iso.datetime({ precision: 3 }), correctionId: z.uuid() })
      .strict()
      .nullable(),
  })
  .strict();
