import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { identifier } from '../../domain/validation.js';
import { customerContactBindingSchema } from '../checkout/customer-contact-authority.js';
import { isLegacyLatinText } from '../checkout/settlement-note.js';
import type { LegacyOrderImportPlan } from './plans.js';
import { csvMembershipCompletionSnapshotSchema } from './membership-profile/completion.js';
import { csvFinancialBenefitSnapshotSchema } from './benefit-profile/completion.js';
import {
  importCorrectionBindingSchema,
  importCorrectionCalculationSchema,
} from './correction-contracts.js';

export const financialImportContract = 'pos-legacy-order-import-financial-v1';
export const financialSourceContract = 'pos-legacy-order-import-source-v1';
export const financialPublicationContract = 'pos-legacy-order-import-publication-v1';
export const financialConfirmationContract = 'pos-legacy-order-import-confirmation-v1';
export const financialOrderPreparationContract = 'pos-import-order-preparation-v1';
/** Server-selected source behavior. Absence preserves original request/HMAC bytes. */
export const financialBenefitContractsSchema = z
  .object({
    automaticCoupon: z.literal('pos-csv-automatic-coupon-v1').optional(),
    complementary: z.literal('pos-csv-pos-complementary-v1').optional(),
  })
  .strict()
  .refine((value) => value.automaticCoupon !== undefined || value.complementary !== undefined);
export type FinancialBenefitContracts = z.infer<typeof financialBenefitContractsSchema>;
export const importProofHash = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z.string().regex(/^\d{1,10}\.\d{2}$/),
  time = z.number().int().safe().positive();
const date = z
  .string()
  .regex(/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDateTime.from(value.replace(' ', 'T')).year >= 1970;
    } catch {
      return false;
    }
  });
const base = {
  sequence: z.number().int().min(1).max(50000),
  firstRow: z.number().int().min(2).max(50001),
  reference: z.string().min(1).max(255),
  storeId: identifier,
  email: z.email().max(254).nullable(),
  createdAt: date,
  lines: z
    .array(
      z
        .object({
          productId: identifier,
          quantity: z.number().int().min(1).max(999),
          unitPrice: amount.refine(
            (value) => /^\d{1,10}\.\d{2}$/.test(value) && BigInt(value.replace('.', '')) > 0n,
          ),
          sourceRows: z.array(z.number().int().min(2).max(50001)).min(1).max(999),
        })
        .strict(),
    )
    .min(1)
    .max(999),
  originalTenderAmount: amount.refine(
    (value) => /^\d{1,10}\.\d{2}$/.test(value) && BigInt(value.replace('.', '')) > 0n,
  ),
};
export const financialImportPlanSchema: z.ZodType<LegacyOrderImportPlan> = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...base,
        kind: z.literal('offline'),
        payment: z.enum(['cash', 'manual-other']),
        sendOrderPlacedSms: z.boolean(),
        message: z.string().max(255).refine(isLegacyLatinText),
      })
      .strict(),
    z
      .object({
        ...base,
        email: z.email().max(254),
        kind: z.literal('shopify'),
        payment: z.literal('shopify'),
        currency: z.string().regex(/^[A-Z]{3}$/),
        address: z.record(z.string().regex(/^shipping_[a-z0-9]+$/), z.string().max(1000)),
        legacyTaxDigit: z.number().int().min(0).max(9),
        shippingCharges: amount,
        discountAmount: amount,
        financialStatus: z.string().max(255),
        declaredSubtotal: amount,
        declaredTaxes: amount,
        declaredTotal: amount,
      })
      .strict(),
  ])
  .refine(
    (plan) =>
      new Set(plan.lines.map((line) => line.productId)).size === plan.lines.length &&
      plan.lines.reduce((sum, line) => sum + line.quantity, 0) <= 999,
  );
export const financialImportScopeSchema = z
  .object({
    actorId: identifier,
    operationId: z.uuid(),
    storeId: identifier,
    counterId: identifier,
  })
  .strict();
export const financialImportCloseSchema = z
  .object({
    id: identifier,
    version: z.number().int().min(1).max(65535),
    status: z.enum(['CLOSED', 'STALE']),
  })
  .strict();
export const financialImportAuthoritySchema = z
  .object({
    customerId: identifier,
    contact: customerContactBindingSchema,
    actorVersion: importProofHash,
    actorEpoch: z.string().regex(/^(?:0|[1-9]\d{0,19})$/),
    approvalId: z.uuid().nullable(),
    close: financialImportCloseSchema.nullable(),
  })
  .strict();
export type FinancialImportAuthority = z.infer<typeof financialImportAuthoritySchema>;
export const financialImportApprovalSchema = z
  .object({
    id: z.uuid(),
    operationId: z.uuid(),
    actorId: identifier,
    storeId: identifier,
    counterId: identifier,
    planHash: importProofHash,
    businessDate: z.iso.date(),
    approverId: identifier,
    reason: z.enum(['late-recording', 'historical-correction', 'source-reconciliation']),
    issuedAt: time,
    expiresAt: time,
    close: financialImportCloseSchema.nullable(),
    status: z.enum(['approved', 'stale']),
  })
  .strict();
export type FinancialImportApprovalView = z.infer<typeof financialImportApprovalSchema>;
export const financialImportStageSchema = z.enum([
  'preparation',
  'order',
  'confirmation',
  'settlement',
  'publication',
]);
export type FinancialImportStage = z.infer<typeof financialImportStageSchema>;
export const sourceOrderReceiptSchema = z
  .object({
    contract: z.literal(financialSourceContract),
    operationId: z.uuid(),
    requestHash: importProofHash,
    namespace: z.string().regex(/^pos-import-v1:[a-f0-9-]{36}$/),
    customerId: identifier,
    storeId: identifier,
    counterId: identifier,
    createdAt: date,
    orderId: identifier,
    headerHash: importProofHash,
    lineHash: importProofHash,
    method: z.union([z.literal(14), z.literal(15)]),
    payable: amount,
    refundAllocationContract: z.literal('pos-refund-per-hp-v1'),
    refundSourcePatchHash: z.literal(
      'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
    ),
    sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
    sourceControllerHash: z.literal(
      'd8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18',
    ),
    lineItemsEnabled: z.boolean(),
    lines: z
      .array(
        z
          .object({
            id: identifier,
            productId: identifier,
            quantity: z.number().int().min(1).max(999),
            inputHash: importProofHash,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    effectsHash: importProofHash,
  })
  .strict();
export type SourceOrderReceipt = z.infer<typeof sourceOrderReceiptSchema>;
export const sourceConfirmationReceiptSchema = z
  .object({
    contract: z.literal(financialConfirmationContract),
    operationId: z.uuid(),
    orderId: identifier,
    requestHash: importProofHash,
    nonce: z.uuid(),
    customerId: identifier,
    storeId: identifier,
    counterId: identifier,
    headerHash: importProofHash,
    confirmedAt: time,
  })
  .strict();
export const sourceRejectionReceiptSchema = z
  .object({
    contract: z.literal(financialSourceContract),
    operationId: z.uuid(),
    requestHash: importProofHash,
    namespace: z.string(),
    status: z.literal('rejected'),
    code: z.string().regex(/^ORDER_IMPORT_[A-Z0-9_]{1,45}$/),
    noFinancialEffects: z.literal(true),
    review: z
      .object({
        contract: z.literal('pos-import-rejection-calculation-v1'),
        planHash: importProofHash,
        stageNonce: z.uuid(),
        rejectedAt: time,
        calculation: importCorrectionCalculationSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export const importPublicationReceiptSchema = z
  .object({
    contract: z.literal(financialPublicationContract),
    operationId: z.uuid(),
    orderId: identifier,
    requestHash: importProofHash,
    sourceHash: importProofHash,
    acceptedAt: time,
    delivery: z.literal('durable-queue-accepted'),
    jobs: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            kind: z.enum([
              'kinesis-chain',
              'engagement',
              'shadow',
              'warehouse',
              'cashback',
              'facebook',
              'sms',
              'membership-cache',
              'cart-tracking',
            ]),
          })
          .strict(),
      )
      .min(2)
      .max(20),
  })
  .strict();
export type ImportPublicationReceipt = z.infer<typeof importPublicationReceiptSchema>;
export const importSettlementReceiptSchema = z
  .object({
    operationId: z.uuid(),
    orderId: identifier,
    kind: z.enum(['offline', 'shopify']),
    stockHash: importProofHash,
    transactionId: z.string().max(255).nullable(),
    paymentId: z.uuid().nullable(),
    cash: amount,
    cashReceived: amount,
    manualOther: amount,
    recordedAt: date,
    finalizedAt: time,
    closeImpactId: z.string().max(100).nullable(),
    smsJobId: z.string().max(80).nullable(),
  })
  .strict();
export type ImportSettlementReceipt = z.infer<typeof importSettlementReceiptSchema>;
export const importCompletedProofSchema = z
  .object({
    contract: z.literal(financialImportContract),
    receiptId: z.uuid(),
    scope: financialImportScopeSchema,
    planHash: importProofHash,
    requestHash: importProofHash,
    authority: financialImportAuthoritySchema,
    kind: z.enum(['offline', 'shopify']),
    businessDate: z.iso.date(),
    order: sourceOrderReceiptSchema,
    settlement: importSettlementReceiptSchema,
    publication: importPublicationReceiptSchema,
    // Absence is preserved for existing HMACs. Never inject a default null.
    membership: csvMembershipCompletionSnapshotSchema.optional(),
    benefits: csvFinancialBenefitSnapshotSchema.optional(),
    benefitContracts: financialBenefitContractsSchema.optional(),
    correction: importCorrectionBindingSchema.optional(),
    finalizedAt: time,
  })
  .strict();
export type ImportCompletedProof = z.infer<typeof importCompletedProofSchema>;
export const importFinancialStateSchema = z
  .object({
    scope: financialImportScopeSchema,
    planHash: importProofHash,
    requestHash: importProofHash,
    namespace: z.string().regex(/^pos-import-v1:[a-f0-9-]{36}$/),
    authority: financialImportAuthoritySchema,
    status: z.enum(['running', 'unknown', 'rejected', 'completed']),
    correction: importCorrectionBindingSchema.optional(),
    preparationContract: z.literal(financialOrderPreparationContract).optional(),
    benefitContracts: financialBenefitContractsSchema.optional(),
    stage: financialImportStageSchema,
    orderId: identifier.nullable(),
    errorCode: z
      .string()
      .regex(/^ORDER_IMPORT_[A-Z0-9_]{1,45}$/)
      .nullable(),
    requestId: z.string().max(128),
    createdAt: time,
    updatedAt: time,
  })
  .strict();
export type ImportFinancialState = z.infer<typeof importFinancialStateSchema>;
