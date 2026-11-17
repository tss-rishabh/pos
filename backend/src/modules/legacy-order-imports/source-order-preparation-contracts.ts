import { z } from 'zod';
import {
  financialImportScopeSchema,
  importProofHash,
  type ImportFinancialState,
  financialBenefitContractsSchema,
} from './financial-adapter-contracts.js';
import { csvMembershipHistoryRequestSchema } from './membership-profile/history.js';
import type { CsvMembershipPrefetch } from './membership-profile/bridge.js';
import { couponHistoryScopeSchema } from './benefit-profile/history.js';
import {
  birthdayObservationSchema,
  couponHistoryWitnessSchema,
  type CsvCouponPrefetch,
} from './benefit-profile/bridge.js';
import type { LegacyOrderImportPlan } from './plans.js';

export const sourceOrderPreparationContract = 'pos-import-order-preparation-v1';
export interface SourceOrderPreparationInput {
  state: ImportFinancialState & { preparationContract?: string };
  plan: LegacyOrderImportPlan;
  attemptId: string;
  expiresAt: number;
}
export interface SourceOrderPreparationPort {
  prepare(
    input: SourceOrderPreparationInput,
    options: { signal: AbortSignal },
  ): Promise<{ membershipHistory?: CsvMembershipPrefetch; couponHistory?: CsvCouponPrefetch }>;
}
const time = z.number().int().safe().positive();
export const sourceOrderPreviewSchema = z
  .object({
    contract: z.literal(sourceOrderPreparationContract),
    purpose: z.literal('source-cart-preview-result'),
    operationId: z.uuid(),
    attemptId: z.uuid(),
    requestHash: importProofHash,
    planHash: importProofHash,
    scope: financialImportScopeSchema,
    authorityHash: importProofHash,
    planDigest: importProofHash,
    attemptExpiresAt: time,
    issuedAt: time,
    expiresAt: time,
    sourceTimeZone: z.string().min(1).max(128),
    outcome: z.enum(['ready', 'need-history', 'need-coupon-history']),
    historyScope: csvMembershipHistoryRequestSchema.nullable(),
    membershipHistoryHash: importProofHash.nullable(),
    // These fields are absent for original, unselected commands. They do not
    // adopt current worker flags on behalf of an already authenticated plan.
    benefitContracts: financialBenefitContractsSchema.optional(),
    couponHistoryHash: importProofHash.nullable().optional(),
    couponHistoryScope: couponHistoryScopeSchema.optional(),
    couponHistoryWitness: couponHistoryWitnessSchema.optional(),
    birthdayObservation: birthdayObservationSchema.optional(),
    signature: importProofHash,
  })
  .strict()
  .refine((value) => (value.outcome === 'need-history') === (value.historyScope !== null))
  .refine((value) => {
    const selected = value.benefitContracts?.automaticCoupon !== undefined,
      needed = value.outcome === 'need-coupon-history';
    return (
      selected === (value.couponHistoryHash !== undefined) &&
      (!needed || selected) &&
      needed === (value.couponHistoryScope !== undefined) &&
      needed === (value.couponHistoryWitness !== undefined) &&
      needed === (value.birthdayObservation !== undefined)
    );
  });
export type SourceOrderPreview = z.infer<typeof sourceOrderPreviewSchema>;
