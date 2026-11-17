import { z } from 'zod';
const id = z.string().regex(/^[1-9]\d{0,18}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  money = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
export const returnEvidenceSchema = z
  .object({
    intentId: z.uuid(),
    attestationId: z.uuid(),
    returnedBy: id,
    attestedBy: id,
    returnedInstant: z.iso.datetime({ precision: 3 }),
    returnedAt: z.string(),
    businessDate: z.iso.date(),
    businessTimezone: z.string(),
    preparedHash: hash,
    origin: z.literal('retained-device-claim').optional(),
  })
  .strict();
const reason = z.enum(['incorrect-payment-record', 'customer-payment-correction']);
export const prepareReturnSchema = z
  .object({
    operationId: z.uuid(),
    correctionId: z.uuid(),
    cashReturnReceiptId: z.uuid(),
    originalPaymentId: z.uuid(),
    snapshotHash: hash,
    counterId: id,
    returnedCash: money,
    reason,
    confirmNoHandover: z.literal(true),
  })
  .strict();
export const attestReturnSchema = z
  .object({
    operationId: z.uuid(),
    returnedAt: z.iso.datetime({ precision: 3 }),
    confirmAlreadyReturned: z.literal(true),
    confirmNoHandover: z.literal(true),
    basis: z.enum(['own-return', 'reviewed-original-return']),
    evidenceId: z.uuid(),
  })
  .strict();
export const cancelReturnSchema = z
  .object({
    operationId: z.uuid(),
    confirmCashNotReturned: z.literal(true),
    evidenceId: z.uuid(),
    reason: z.enum(['customer-retained-payment', 'preparation-error', 'correction-not-needed']),
  })
  .strict();
export const cashReturnViewSchema = z
  .object({
    id: z.uuid(),
    contract: z.literal('pos-cash-return-intent-v1'),
    revision: z.number().int().positive(),
    phase: z.enum(['PREPARED', 'RETURN_PENDING', 'ATTESTED', 'RECORDED', 'CANCELLED']),
    orderId: id,
    storeId: id,
    counterId: id,
    preparedBy: id,
    preparedAt: z.iso.datetime({ precision: 3 }),
    correctionId: z.uuid(),
    cashReturnReceiptId: z.uuid(),
    originalPaymentId: z.uuid(),
    returnedCash: money,
    reason,
    armed: z
      .object({ actorId: id, at: z.iso.datetime({ precision: 3 }) })
      .strict()
      .nullable(),
    attestation: z
      .object({
        actorId: id,
        at: z.iso.datetime({ precision: 3 }),
        evidenceId: z.uuid(),
        evidence: returnEvidenceSchema,
      })
      .strict()
      .nullable(),
    cancellation: z
      .object({
        actorId: id,
        at: z.iso.datetime({ precision: 3 }),
        reason: cancelReturnSchema.shape.reason,
        evidenceId: z.uuid(),
      })
      .strict()
      .nullable(),
    resolution: z
      .object({ actorId: id, at: z.iso.datetime({ precision: 3 }), correctionId: z.uuid() })
      .strict()
      .nullable(),
  })
  .strict();
export const cashReturnReplySchema = z
  .object({
    operationId: z.uuid(),
    kind: z.enum(['prepare', 'arm', 'attest', 'cancel', 'resolve']),
    actorId: id,
    intent: cashReturnViewSchema,
    newlyArmed: z.boolean(),
  })
  .strict();
export type CashReturnView = z.infer<typeof cashReturnViewSchema>;
export const claimViewSchema = z
  .object({
    id: z.uuid(),
    origin: z.literal('retained-device'),
    phase: z.enum(['ATTESTED', 'RECORDED']),
    orderId: id,
    storeId: id,
    counterId: id,
    registeredBy: id,
    registeredAt: z.iso.datetime({ precision: 3 }),
    returnedBy: id,
    returnedAt: z.string(),
    returnedInstant: z.iso.datetime({ precision: 3 }),
    businessDate: z.iso.date(),
    returnedCash: money,
    originalPaymentId: z.uuid(),
    cashReturnReceiptId: z.uuid(),
  })
  .strict();
export type ClaimView = z.infer<typeof claimViewSchema>;
export const returnJournalSchema = z
  .object({
    version: z.literal(1),
    intentId: z.uuid(),
    correctionId: z.uuid(),
    instructionConsumed: z.boolean(),
    attestationRetryId: z.uuid().optional(),
    prepare: prepareReturnSchema.nullable(),
    pending: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('prepare'), operationId: z.uuid() }).strict(),
        z.object({ kind: z.literal('arm'), operationId: z.uuid() }).strict(),
        z
          .object({ kind: z.literal('attest'), operationId: z.uuid(), input: attestReturnSchema })
          .strict(),
        z
          .object({ kind: z.literal('cancel'), operationId: z.uuid(), input: cancelReturnSchema })
          .strict(),
        z.object({ kind: z.literal('resolve'), operationId: z.uuid() }).strict(),
      ])
      .nullable(),
  })
  .strict();
export type ReturnJournal = z.infer<typeof returnJournalSchema>;
