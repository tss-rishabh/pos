import { z } from 'zod';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { identifier } from '../../domain/validation.js';
import type { LegacyOrderImportPlan } from './plans.js';

export const importCorrectionContract = 'pos-import-manager-correction-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().safe().positive();
export const correctionAmount = z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/);
const scope = z
  .object({
    actorId: identifier,
    operationId: z.uuid(),
    storeId: identifier,
    counterId: identifier,
  })
  .strict();
export const importCorrectionCalculationSchema = z
  .object({
    payable: correctionAmount,
    calculationHash: hash,
    profileQualified: z.boolean(),
    profileCode: z
      .string()
      .regex(/^ORDER_IMPORT_[A-Z0-9_]{1,45}$/)
      .nullable(),
  })
  .strict();
export const importCorrectionBoundarySchema = z
  .object({
    contract: z.literal('pos-import-rejected-boundary-v1'),
    scope,
    planHash: hash,
    financialRequestHash: hash,
    namespace: z.string().regex(/^pos-import-v1:[a-f0-9-]{36}$/),
    stageNonce: z.uuid(),
    stageRequestHash: hash,
    rejectionHash: hash,
    rejectionCode: z.string().regex(/^ORDER_IMPORT_[A-Z0-9_]{1,45}$/),
    rejectedAt: time,
    customerId: identifier,
    contact: z
      .object({ revision: z.string().regex(/^(?:0|[1-9]\d{0,19})$/), digest: hash })
      .strict(),
    noFinancialEffects: z.literal(true),
    calculation: importCorrectionCalculationSchema.nullable(),
  })
  .strict();
export type ImportCorrectionRejectedBoundary = z.infer<typeof importCorrectionBoundarySchema>;

export const importCorrectionBindingSchema = z
  .object({
    contract: z.literal(importCorrectionContract),
    id: z.uuid(),
    root: z.object({ jobId: z.uuid(), operationId: z.uuid(), uploadHash: hash }).strict(),
    previousCorrectionId: z.uuid().nullable(),
    depth: z.number().int().min(1).max(10),
    original: z
      .object({
        jobId: z.uuid(),
        operationId: z.uuid(),
        actorId: identifier,
        uploadHash: hash,
        encryptedGroupHash: hash,
        planHash: hash,
        sequence: z.number().int().min(1).max(50000),
        firstRow: z.number().int().min(2).max(50001),
        boundary: importCorrectionBoundarySchema,
      })
      .strict(),
    successor: scope.extend({ jobId: z.uuid() }).strict(),
    businessDateTime: z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    payment: z.enum(['cash', 'manual-other']),
    orderedRowsHash: hash,
    historicalTenderAmount: correctionAmount,
    reason: z.literal('historical-correction'),
    manager: z
      .object({
        id: identifier,
        actorVersion: hash,
        sessionHash: hash,
        evidenceId: z.uuid(),
        attestedAt: time,
        confirmHistoricalTender: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type ImportCorrectionBinding = z.infer<typeof importCorrectionBindingSchema>;
export interface ImportCorrectionBoundaryPort {
  /** Trusted native/private financial-core verifier. No HTTP or source dispatch in this call. */
  inspectRejectedBoundary(
    transaction: AdministrationTransaction,
    input: {
      scope: z.infer<typeof scope>;
      plan: LegacyOrderImportPlan;
      planHash: string;
      correction?: ImportCorrectionBinding;
    },
  ): Promise<ImportCorrectionRejectedBoundary>;
  /** Future price-correction profile: read an already retained/sealed preflight.
   * This seam must not perform HTTP or mint an order/stage while locks are held.
   * The initial active profile preserves prices and does not invoke this seam. */
  inspectCorrectedPlan?(
    transaction: AdministrationTransaction,
    input: {
      scope: z.infer<typeof scope>;
      originalBoundary: ImportCorrectionRejectedBoundary;
      plan: LegacyOrderImportPlan;
      planHash: string;
    },
  ): Promise<{
    contract: 'pos-import-correction-preflight-v1';
    planHash: string;
    originalRejectionHash: string;
    calculation: z.infer<typeof importCorrectionCalculationSchema>;
  } | null>;
}

export const importCorrectionInputSchema = z
  .object({
    id: z.uuid(),
    successorJobId: z.uuid(),
    successorOperationId: z.uuid(),
    reviewHash: hash,
    historicalTenderAmount: correctionAmount,
    evidenceId: z.uuid(),
    confirmHistoricalTender: z.literal(true),
    lines: z
      .array(
        z
          .object({
            row: z.number().int().min(2).max(50001),
            unitPrice: correctionAmount.refine((value) => BigInt(value.replace('.', '')) > 0n),
          })
          .strict(),
      )
      .min(1)
      .max(999),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set([value.id, value.successorJobId, value.successorOperationId, value.evidenceId])
        .size !== 4
    )
      context.addIssue({
        code: 'custom',
        message: 'Use distinct correction and evidence references.',
      });
    if (new Set(value.lines.map((line) => line.row)).size !== value.lines.length)
      context.addIssue({ code: 'custom', message: 'Each original CSV row must be reviewed once.' });
  });
export type ImportCorrectionInput = z.infer<typeof importCorrectionInputSchema>;
const correctionReceipt = z
  .object({
    id: z.uuid(),
    originalJobId: z.uuid(),
    originalOperationId: z.uuid(),
    successorJobId: z.uuid(),
    successorOperationId: z.uuid(),
    managerId: identifier,
    originalLineValue: correctionAmount,
    correctedLineValue: correctionAmount,
    historicalTenderAmount: correctionAmount,
    recordedAt: time,
    requiresApproval: z.literal(true),
    financialExecution: z.literal('pending-approval'),
  })
  .strict();
export const importCorrectionReceiptSchema = correctionReceipt;
export type ImportCorrectionReceipt = z.infer<typeof correctionReceipt>;
export const importCorrectionFenceSchema = z
  .object({
    contract: z.literal('pos-import-correction-command-v1'),
    status: z.literal('not-created'),
    id: z.uuid(),
    originalJobId: z.uuid(),
    originalOperationId: z.uuid(),
    managerId: identifier,
    recordedAt: time,
    noSuccessorQueued: z.literal(true),
    latePostsFenced: z.literal(true),
  })
  .strict();
export const importCorrectionCommandOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), receipt: correctionReceipt }).strict(),
  importCorrectionFenceSchema,
]);
export type ImportCorrectionCommandOutcome = z.infer<typeof importCorrectionCommandOutcomeSchema>;
export const importCorrectionReviewSchema = z
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
        businessDateTime: z.string(),
        payment: z.enum(['cash', 'manual-other', 'shopify']),
        lineValue: correctionAmount,
        lines: z
          .array(
            z
              .object({
                row: z.number().int().min(2).max(50001),
                productId: identifier,
                quantity: z.number().int().min(1).max(999),
                unitPrice: correctionAmount,
              })
              .strict(),
          )
          .min(1)
          .max(999),
      })
      .strict(),
    calculation: importCorrectionCalculationSchema.nullable(),
    successor: correctionReceipt.nullable(),
  })
  .strict();
export type ImportCorrectionReview = z.infer<typeof importCorrectionReviewSchema>;
