import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { readSourceOrderPreparationOptions } from '../../src/modules/legacy-order-imports/source-order-preparation-options.js';
import {
  sourceOrderPreparationContract,
  type SourceOrderPreparationInput,
  type SourceOrderPreview,
} from '../../src/modules/legacy-order-imports/source-order-preparation-contracts.js';
import { expectedFinancialPlanHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import {
  csvMembershipHistoryHash,
  type CsvMembershipHistoryRequest,
  type QualifiedCsvMembershipHistory,
} from '../../src/modules/legacy-order-imports/membership-profile/history.js';
import { memberEvidence } from '../legacy-import-membership/adapter-fixtures.js';
import { z } from 'zod';

export const preparationNow = Date.parse('2026-11-17T06:30:03.000Z'),
  preparationKeys = {
    secret: 'fixture-master-no-source-access-'.repeat(2),
    sourceAuthKey: 'fixture-source-preview-auth-only-'.repeat(2),
    sourceProofKey: 'fixture-source-preview-receipt-only-'.repeat(2),
    historyKey: 'fixture-bounded-membership-history-'.repeat(2),
    publicationKey: 'fixture-source-publication-only-'.repeat(2),
  },
  preparationConfig = { NODE_ENV: 'test' as const, BUSINESS_TIMEZONE: 'Asia/Kolkata' },
  preparationFinancial = {
    ...preparationKeys,
    sourceUrl: 'https://private.example.test/internal/pos/legacy-order-imports',
  };
export function preparationInput(): SourceOrderPreparationInput {
  const f = memberEvidence('offline', true),
    state: SourceOrderPreparationInput['state'] = {
      ...f.state,
      status: 'running' as const,
      stage: 'preparation' as const,
      orderId: null,
      preparationContract: sourceOrderPreparationContract,
    };
  state.planHash = expectedFinancialPlanHash(preparationKeys.secret, state.scope, f.plan);
  return { state, plan: f.plan, attemptId: randomUUID(), expiresAt: preparationNow + 60000 };
}
export function preparationScope(input: SourceOrderPreparationInput): CsvMembershipHistoryRequest {
  return {
    contract: 'pos-csv-membership-history-v1',
    operationId: input.state.scope.operationId,
    requestHash: input.state.requestHash,
    planHash: input.state.planHash,
    customerId: input.state.authority.customerId,
    asOf: '2026-11-17 12:00:03',
    cutoff: '2026-10-03 12:00:03',
  };
}
export function preparationDocument(
  scope: CsvMembershipHistoryRequest,
): QualifiedCsvMembershipHistory {
  const value = {
    scope,
    reader: 'bigquery' as const,
    generationId: 'f'.repeat(64),
    complete: true as const,
    fetchedAt: preparationNow,
    lastDeliveredOrder: null,
    recentDeliveredOrders: [],
  };
  return { ...value, signature: csvMembershipHistoryHash(value, preparationKeys.historyKey) };
}
export function preparationOptions(history = false) {
  return readSourceOrderPreparationOptions({
    UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT: sourceOrderPreparationContract,
    ...(history
      ? {
          CSV_MEMBERSHIP_HISTORY_KEY: preparationKeys.historyKey,
          CSV_MEMBERSHIP_PUBLICATION_KEY: preparationKeys.publicationKey,
          POS_MEMBERSHIP_PRODUCT_IDS: '["10","12"]',
          CSV_MEMBERSHIP_SOURCE_TIMEZONE: 'Asia/Kolkata',
        }
      : {}),
  });
}
const capability = z.object({
  operationId: z.string(),
  attemptId: z.string(),
  requestHash: z.string(),
  planHash: z.string(),
  scope: z.object({
    actorId: z.string(),
    operationId: z.string(),
    storeId: z.string(),
    counterId: z.string(),
  }),
  authorityHash: z.string(),
  planDigest: z.string(),
  expiresAt: z.number(),
  attemptExpiresAt: z.number(),
  membershipHistoryHash: z.string().optional(),
});
export function previewFetch(
  input: SourceOrderPreparationInput,
  outcomes: ('ready' | 'need-history')[],
  mutate?: (body: SourceOrderPreview) => SourceOrderPreview,
) {
  const requests: { url: string; body: unknown }[] = [];
  const fetcher: typeof fetch = vi.fn(async (url, options) => {
    const raw: unknown = JSON.parse(String(options?.body)),
      c = capability.parse(z.object({ capability: z.unknown() }).parse(raw).capability);
    requests.push({ url: String(url), body: raw });
    const outcome = outcomes[requests.length - 1] ?? 'ready';
    const value: Omit<SourceOrderPreview, 'signature'> = {
      contract: sourceOrderPreparationContract,
      purpose: 'source-cart-preview-result',
      operationId: c.operationId,
      attemptId: c.attemptId,
      requestHash: c.requestHash,
      planHash: c.planHash,
      scope: c.scope,
      authorityHash: c.authorityHash,
      planDigest: c.planDigest,
      issuedAt: preparationNow,
      expiresAt: c.expiresAt,
      attemptExpiresAt: c.attemptExpiresAt,
      sourceTimeZone: 'Asia/Kolkata',
      outcome,
      historyScope: outcome === 'need-history' ? preparationScope(input) : null,
      membershipHistoryHash: c.membershipHistoryHash ?? null,
    };
    const response = {
      ...value,
      signature: operationHash(
        'legacy-order-imports.source.preparation-result.v1',
        value,
        preparationKeys.sourceProofKey,
      ),
    };
    return Response.json(mutate?.(response) ?? response);
  });
  return { fetcher, requests };
}
