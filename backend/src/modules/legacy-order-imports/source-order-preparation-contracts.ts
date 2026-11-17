import { z } from 'zod';
import {
  financialImportScopeSchema,
  importProofHash,
  type ImportFinancialState,
} from './financial-adapter-contracts.js';
import { csvMembershipHistoryRequestSchema } from './membership-profile/history.js';
import type { CsvMembershipPrefetch } from './membership-profile/bridge.js';
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
  ): Promise<{ membershipHistory?: CsvMembershipPrefetch }>;
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
    outcome: z.enum(['ready', 'need-history']),
    historyScope: csvMembershipHistoryRequestSchema.nullable(),
    membershipHistoryHash: importProofHash.nullable(),
    signature: importProofHash,
  })
  .strict()
  .refine((value) => (value.outcome === 'need-history') === (value.historyScope !== null));
export type SourceOrderPreview = z.infer<typeof sourceOrderPreviewSchema>;
