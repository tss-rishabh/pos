import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { sourceOrderPreparation } from '../../src/modules/legacy-order-imports/source-order-preparation.js';
import { readSourceOrderPreparationOptions } from '../../src/modules/legacy-order-imports/source-order-preparation-options.js';
import { financialBenefitContractsSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  couponHistoryControlHeadHash,
  type BirthdayObservation,
  type CouponHistoryWitness,
} from '../../src/modules/legacy-order-imports/benefit-profile/bridge.js';
import { benefitDigest } from '../../src/modules/legacy-order-imports/benefit-profile/crypto.js';
import {
  couponHistoryHash,
  type CouponHistoryScope,
  type QualifiedCouponHistory,
} from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import { csvMembershipHistoryHash } from '../../src/modules/legacy-order-imports/membership-profile/history.js';
import type { SourceOrderPreview } from '../../src/modules/legacy-order-imports/source-order-preparation-contracts.js';
import {
  preparationConfig,
  preparationDocument,
  preparationFinancial,
  preparationInput,
  preparationKeys,
  preparationNow,
  preparationScope,
} from './fixtures.js';

const historyKey = 'fixture-lazy-coupon-history-'.repeat(2),
  guardKey = 'fixture-lazy-coupon-guard-'.repeat(2);
function setup(steps: SourceOrderPreview['outcome'][], member = false) {
  const input = preparationInput();
  input.state.benefitContracts = { automaticCoupon: 'pos-csv-automatic-coupon-v1' };
  const scope: CouponHistoryScope = {
      contract: 'pos-csv-coupon-history-v1',
      operationId: input.state.scope.operationId,
      requestHash: input.state.requestHash,
      planHash: input.state.planHash,
      customerId: input.state.authority.customerId,
      couponId: '222',
      configurationHash: 'c'.repeat(64),
      asOf: '2026-11-17 12:00:03',
      sourceTimeZone: 'Asia/Kolkata',
    },
    witness: CouponHistoryWitness = {
      writersContract: 'pos-csv-coupon-history-all-writers-v1',
      writersDefinitionHash: 'd'.repeat(64),
      serverUuid: randomUUID(),
      sourceSchema: 'fixture',
      heads: [
        { kind: 'controls', scopeId: '0', revision: '1' },
        { kind: 'coupon', scopeId: '222', revision: '2' },
        { kind: 'customer', scopeId: scope.customerId, revision: '3' },
      ],
    },
    guard = {
      contract: 'pos-csv-birthday-cooperative-guard-v1' as const,
      operationId: scope.operationId,
      requestHash: scope.requestHash,
      customerId: scope.customerId,
      observedAt: preparationNow,
      present: false,
    },
    observation: BirthdayObservation = {
      ...guard,
      signature: benefitDigest('birthday-observation', guard, guardKey),
    },
    documentBody: Omit<QualifiedCouponHistory, 'signature'> = {
      scope,
      reader: 'bigquery',
      generationId: 'f'.repeat(64),
      complete: true,
      fetchedAt: preparationNow,
      publication: {
        sourceCaptureHash: 'a'.repeat(64),
        controlHeadHash: couponHistoryControlHeadHash(
          scope,
          witness,
          preparationKeys.sourceProofKey,
        ),
        queryContract: 'pos-source-coupon-selects-2960-v1',
        seal: 'b'.repeat(64),
      },
      globalUsage: '2',
      birthdayTodayUsage: '0',
      customerOrderCount: '1',
      monthlyJoinedUsage: '0',
      lotCounts: [],
    },
    document = { ...documentBody, signature: couponHistoryHash(documentBody, historyKey) },
    requests: { body: Record<string, unknown>; url: string }[] = [];
  let now = preparationNow;
  const capSchema = z.object({
    operationId: z.string(),
    attemptId: z.string(),
    requestHash: z.string(),
    planHash: z.string(),
    scope: z.object({
      actorId: z.string(),
      storeId: z.string(),
      counterId: z.string(),
      operationId: z.string(),
    }),
    authorityHash: z.string(),
    planDigest: z.string(),
    expiresAt: z.number(),
    attemptExpiresAt: z.number(),
    membershipHistoryHash: z.string().optional(),
    couponHistoryHash: z.string().optional(),
    benefitContracts: financialBenefitContractsSchema.optional(),
  });
  const fetcher: typeof fetch = vi.fn(async (url, options) => {
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(options?.body))),
      cap = capSchema.parse(body.capability),
      outcome = steps[requests.length] ?? 'ready';
    requests.push({ body, url: String(url) });
    const value: Omit<SourceOrderPreview, 'signature'> = {
      contract: 'pos-import-order-preparation-v1',
      purpose: 'source-cart-preview-result',
      operationId: cap.operationId,
      attemptId: cap.attemptId,
      requestHash: cap.requestHash,
      planHash: cap.planHash,
      scope: cap.scope,
      authorityHash: cap.authorityHash,
      planDigest: cap.planDigest,
      attemptExpiresAt: cap.attemptExpiresAt,
      issuedAt: now,
      expiresAt: cap.expiresAt,
      sourceTimeZone: 'Asia/Kolkata',
      outcome,
      historyScope: outcome === 'need-history' ? preparationScope(input) : null,
      membershipHistoryHash: cap.membershipHistoryHash ?? null,
      ...(cap.benefitContracts ? { benefitContracts: cap.benefitContracts } : {}),
      ...(cap.benefitContracts?.automaticCoupon
        ? { couponHistoryHash: cap.couponHistoryHash ?? null }
        : {}),
      ...(outcome === 'need-coupon-history'
        ? {
            couponHistoryScope: scope,
            couponHistoryWitness: witness,
            birthdayObservation: observation,
          }
        : {}),
    };
    return Response.json({
      ...value,
      signature: operationHash(
        'legacy-order-imports.source.preparation-result.v1',
        value,
        preparationKeys.sourceProofKey,
      ),
    });
  });
  const options = readSourceOrderPreparationOptions({
    UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT: 'pos-import-order-preparation-v1',
    CSV_COUPON_HISTORY_KEY: historyKey,
    CSV_COUPON_GUARD_KEY: guardKey,
    ...(member
      ? {
          CSV_MEMBERSHIP_HISTORY_KEY: preparationKeys.historyKey,
          CSV_MEMBERSHIP_PUBLICATION_KEY: preparationKeys.publicationKey,
          POS_MEMBERSHIP_PRODUCT_IDS: '["10","12"]',
          CSV_MEMBERSHIP_SOURCE_TIMEZONE: 'Asia/Kolkata',
        }
      : {}),
  });
  return {
    input,
    scope,
    witness,
    document,
    options,
    fetcher,
    requests,
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('lazy authenticated coupon preparation', () => {
  it('does not call either provider when literal coupon eligibility needs no history', async () => {
    const f = setup(['ready']),
      read = vi.fn();
    expect(
      await sourceOrderPreparation(preparationConfig, preparationFinancial, f.options, {
        ...f,
        couponHistoryReader: { read },
        historyReader: { read },
      }).prepare(f.input, { signal: new AbortController().signal }),
    ).toEqual({});
    expect(read).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(1);
  });
  it.each([
    ['need-coupon-history', 'need-history', 'ready'],
    ['need-history', 'need-coupon-history', 'ready'],
  ] as const)('copies both original generations through bounded previews: %j', async (...steps) => {
    const f = setup([...steps], true),
      couponRead = vi.fn(async () => f.document),
      memberRead = vi.fn(async () => preparationDocument(preparationScope(f.input)));
    const result = await sourceOrderPreparation(
      preparationConfig,
      preparationFinancial,
      f.options,
      { ...f, couponHistoryReader: { read: couponRead }, historyReader: { read: memberRead } },
    ).prepare(f.input, { signal: new AbortController().signal });
    expect(couponRead).toHaveBeenCalledExactlyOnceWith(f.scope, {
      witness: f.witness,
      signal: expect.any(AbortSignal),
    });
    expect(memberRead).toHaveBeenCalledOnce();
    expect(result.couponHistory?.document).toEqual(f.document);
    expect(result.membershipHistory?.document.generationId).toBe('f'.repeat(64));
    expect(f.requests).toHaveLength(3);
    expect(f.requests.at(-1)?.body).toMatchObject(result);
    expect(f.requests.every(({ url }) => url.endsWith('/preparation'))).toBe(true);
  });
  it('fails locally on required history without a provider, and never reissues a repeated history escape', async () => {
    const f = setup(['need-coupon-history']);
    await expect(
      sourceOrderPreparation(preparationConfig, preparationFinancial, f.options, f).prepare(
        f.input,
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_COUPON_HISTORY_REQUIRED' });
    expect(f.requests).toHaveLength(1);
    const again = setup(['need-coupon-history', 'need-coupon-history']),
      read = vi.fn(async () => again.document);
    await expect(
      sourceOrderPreparation(preparationConfig, preparationFinancial, again.options, {
        ...again,
        couponHistoryReader: { read },
      }).prepare(again.input, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_PREPARATION_INVALID' });
    expect(read).toHaveBeenCalledOnce();
    expect(again.requests).toHaveLength(2);
  });
  it('clips and re-signs member capability to the native attempt after a slow source preview', async () => {
    const f = setup(['need-history', 'ready'], true);
    f.input.expiresAt = preparationNow + 40000;
    f.advance(2000);
    const result = await sourceOrderPreparation(
      preparationConfig,
      preparationFinancial,
      f.options,
      {
        ...f,
        historyReader: {
          read: async (scope) => {
            const body = { ...preparationDocument(scope), fetchedAt: f.clock() };
            const { signature: _old, ...unsigned } = body;
            return {
              ...unsigned,
              signature: csvMembershipHistoryHash(unsigned, preparationKeys.historyKey),
            };
          },
        },
      },
    ).prepare(f.input, { signal: new AbortController().signal });
    expect(result.membershipHistory?.capability.expiresAt).toBe(f.input.expiresAt);
    expect(Object.isFrozen(result.membershipHistory?.capability)).toBe(true);
    const { signature, ...body } = result.membershipHistory!.capability;
    expect(signature).toBe(
      operationHash(
        'legacy-order-imports.membership-prefetch.v1',
        body,
        preparationKeys.historyKey,
      ),
    );
  });
  it('rejects changed current controls, stale guard, scope substitution and oversized history before another preview', async () => {
    for (const field of ['control', 'guard', 'scope', 'size'] as const) {
      const f = setup(['need-coupon-history']);
      if (field === 'control') f.document.publication.controlHeadHash = '0'.repeat(64);
      if (field === 'scope') f.document.scope.customerId = '88';
      if (field === 'guard') f.advance(60000);
      if (field === 'size')
        f.document.lotCounts = Array.from({ length: 1001 }, (_, i) => ({
          couponId: String(i + 1),
          sameCode: true,
          noTimesAllowed: '1',
          uniqueNoTimesAllowed: '1',
          usedCount: '0',
        }));
      await expect(
        sourceOrderPreparation(preparationConfig, preparationFinancial, f.options, {
          ...f,
          couponHistoryReader: { read: async () => f.document },
        }).prepare(f.input, { signal: new AbortController().signal }),
      ).rejects.toBeDefined();
      expect(f.requests.length).toBeLessThanOrEqual(1);
    }
  });
});
