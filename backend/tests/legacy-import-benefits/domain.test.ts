import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import {
  automaticCouponReceiptSchema,
  benefitReceiptHash,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import { verifyCsvBenefitComposition } from '../../src/modules/legacy-order-imports/benefit-profile/ownership.js';
import {
  assertQualifiedCouponHistory,
  couponHistoryHash,
  preloadCouponHistory,
} from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import {
  csvMembershipReceiptHash,
  csvMembershipReceiptSchema,
  membershipProvenanceHash,
} from '../../src/modules/legacy-order-imports/membership-profile/domain.js';
import {
  benefitFixture,
  historyFixture,
  historyKey,
  memberKey,
  now,
  sourceKey,
} from './fixture.js';

describe('CSV source benefit ownership and signed evidence', () => {
  it('preserves selected freebie qty1/zero price and Shopify ORIGINAL plan stock qty', () => {
    for (const kind of ['offline', 'shopify'] as const) {
      const f = benefitFixture(kind),
        result = verifyCsvBenefitComposition(f);
      expect(result.ownership.map((row) => row.owner)).toEqual([
        'original-plan',
        'pos-complementary',
      ]);
      expect(result.stock.lines[1]!.quantity).toBe(kind === 'offline' ? 1 : 3);
      expect(result.complementary!.selections[0]!.declaredUnitPrice).toBe('17.83');
    }
  });
  for (const field of [
    'actorId',
    'operationId',
    'customerId',
    'storeId',
    'counterId',
    'requestHash',
    'planHash',
    'headerHash',
    'lineHash',
    'authorityHash',
  ] as const)
    it(`rejects even newly signed wrong ${field}`, () => {
      const f = benefitFixture(),
        changed = structuredClone(f.complementary.value);
      changed.scope[field] =
        field === 'operationId' ? randomUUID() : field.endsWith('Hash') ? 'f'.repeat(64) : '999';
      expect(() =>
        verifyCsvBenefitComposition({
          ...f,
          complementary: {
            value: changed,
            seal: benefitReceiptHash('complementary', changed, sourceKey),
          },
        }),
      ).toThrow();
    });
  it('refuses fabricated automatic gifts, missing descriptors, duplicate HPs and quantity rewrites', () => {
    const f = benefitFixture();
    expect(() => verifyCsvBenefitComposition({ ...f, complementary: undefined })).toThrow();
    const changed = structuredClone(f.complementary.value);
    changed.selections[0]!.declaredQuantity = 1;
    expect(() =>
      verifyCsvBenefitComposition({
        ...f,
        complementary: {
          value: changed,
          seal: benefitReceiptHash('complementary', changed, sourceKey),
        },
      }),
    ).toThrow();
    expect(() =>
      verifyCsvBenefitComposition({
        ...f,
        order: { ...f.order, lines: [...f.order.lines, f.order.lines[0]!] },
      }),
    ).toThrow();
    expect(() =>
      verifyCsvBenefitComposition({
        ...f,
        order: {
          ...f.order,
          lines: [
            ...f.order.lines,
            { id: '99', productId: '99', quantity: 1, inputHash: 'd'.repeat(64) },
          ],
        },
      }),
    ).toThrow();
  });
  it('composes independently signed membership ownership without arbitrary extraRows', () => {
    const f = benefitFixture(),
      member = {
        id: '9007199254741200',
        productId: '10',
        quantity: 1 as const,
        inputHash: 'a'.repeat(64),
      };
    f.order.lines.push(member);
    const provenance = {
      orderId: f.order.orderId,
      customerId: f.order.customerId,
      revision: '1',
      headerHash: f.order.headerHash,
      before: [],
      confirmed: ['EXCLUSIVE_EXPIRY', 'EXCLUSIVE_MEMBER'].map((attribute) => ({
        attribute: attribute as 'EXCLUSIVE_EXPIRY' | 'EXCLUSIVE_MEMBER',
        value: '1',
        active: 0,
        createdAt: f.plan.createdAt,
        updatedAt: f.plan.createdAt,
        hash: 'a'.repeat(64),
      })),
      contract: 'pos-cancellation-membership-staged-v2' as const,
      operationId: randomUUID(),
      createdAt: f.plan.createdAt,
      entityDigest: 'b'.repeat(64),
      proofHash: '',
    };
    provenance.proofHash = membershipProvenanceHash(provenance, memberKey);
    const receipt = csvMembershipReceiptSchema.parse({
      contract: 'pos-legacy-import-membership-v1',
      operationId: f.state.scope.operationId,
      requestHash: f.state.requestHash,
      planHash: f.state.planHash,
      actorId: f.state.scope.actorId,
      authorityHash: operationHash(
        'legacy-order-imports.source.membership-authority.v1',
        f.state.authority,
        sourceKey,
      ),
      namespace: f.state.namespace,
      orderId: f.order.orderId,
      customerId: '77',
      storeId: '1',
      counterId: '3',
      method: 14,
      sourceCommit: f.order.sourceCommit,
      kind: 'auto-free',
      eligibility: 'source-cart-over-2000',
      headerHash: f.order.headerHash,
      lineHash: f.order.lineHash,
      memberLines: [member],
      additionalLines: [member],
      provenance,
      cacheInvalidations: 1,
    });
    const membership = {
      value: receipt,
      seal: csvMembershipReceiptHash(receipt, sourceKey),
      membershipProofKey: memberKey,
      productIds: ['10'],
      freeProductId: '10',
    };
    const result = verifyCsvBenefitComposition({ ...f, membership });
    expect(result.ownership.map((row) => row.owner)).toEqual([
      'original-plan',
      'pos-complementary',
      'membership',
    ]);
    const bad = structuredClone(receipt);
    bad.additionalLines[0]!.productId = '99';
    expect(() =>
      verifyCsvBenefitComposition({
        ...f,
        membership: { ...membership, value: bad, seal: csvMembershipReceiptHash(bad, sourceKey) },
      }),
    ).toThrow();
  });
  it('requires exact allocations for every HP and preserves Shopify no coupon-consumption semantics', () => {
    for (const kind of ['offline', 'shopify'] as const) {
      const f = benefitFixture(kind),
        coupon = automaticCouponReceiptSchema.parse({
          contract: 'pos-csv-automatic-coupon-v1',
          scope: f.scope,
          trigger: 'automatic-birthday',
          couponId: '222',
          configurationHash: 'a'.repeat(64),
          couponInputHash: 'b'.repeat(64),
          history: {
            generationId: 'c'.repeat(64),
            documentHash: 'd'.repeat(64),
            scopeHash: 'e'.repeat(64),
          },
          birthdayClaim: {
            id: randomUUID(),
            keyHash: 'f'.repeat(64),
            receiptHash: 'a'.repeat(64),
            expiresAt: now + 1000,
          },
          cartCouponDiscount: '20.00',
          headerCouponId: kind === 'offline' ? '222' : null,
          headerCouponAmount: kind === 'offline' ? '20.00' : '0.00',
          consumption: kind === 'offline' ? 'offline-go-confirmation' : 'shopify-none',
          couponUsersBefore: [],
          allocations: f.order.lines.map((line, i) => ({
            ...line,
            discount: i === 0 ? '20.00' : '0.00',
            refundable: i === 0 ? '180.00' : '0.00',
            refundInputHash: 'a'.repeat(64),
          })),
          refundAllocationContract: f.order.refundAllocationContract,
          refundSourcePatchHash: f.order.refundSourcePatchHash,
        });
      expect(
        verifyCsvBenefitComposition({
          ...f,
          coupon: { value: coupon, seal: benefitReceiptHash('coupon', coupon, sourceKey) },
        }).coupon!.consumption,
      ).toBe(coupon.consumption);
      coupon.allocations.pop();
      expect(() =>
        verifyCsvBenefitComposition({
          ...f,
          coupon: { value: coupon, seal: benefitReceiptHash('coupon', coupon, sourceKey) },
        }),
      ).toThrow();
    }
  });
});

describe('preloaded exact coupon history', () => {
  it('accepts complete signed zero history, not a missing publication', async () => {
    const facts = historyFixture();
    expect(assertQualifiedCouponHistory(facts, facts.scope, historyKey, now).reader).toBe(
      'bigquery',
    );
    expect(
      await preloadCouponHistory({ read: async () => facts }, facts.scope, historyKey, () => now),
    ).toEqual(facts);
    await expect(
      preloadCouponHistory(
        {
          read: async () => {
            throw new Error('No publication');
          },
        },
        facts.scope,
        historyKey,
      ),
    ).rejects.toThrow();
  });
  for (const mutation of [
    'old',
    'future',
    'incomplete',
    'mysql',
    'changed-customer',
    'changed-plan',
    'unknown-field',
    'negative',
    'duplicate-lot',
  ] as const)
    it(`refuses ${mutation} instead of falling back to historical MySQL`, () => {
      const facts = historyFixture(),
        value: Record<string, unknown> = structuredClone(facts);
      if (mutation === 'old') value.fetchedAt = now - 60001;
      if (mutation === 'future') value.fetchedAt = now + 1;
      if (mutation === 'incomplete') value.complete = false;
      if (mutation === 'mysql') value.reader = 'mysql';
      if (mutation === 'changed-customer') value.scope = { ...facts.scope, customerId: '88' };
      if (mutation === 'changed-plan') value.scope = { ...facts.scope, planHash: 'f'.repeat(64) };
      if (mutation === 'unknown-field') value.debug = 'not permitted';
      if (mutation === 'negative') value.globalUsage = '-1';
      if (mutation === 'duplicate-lot')
        value.lotCounts = Array(2).fill({
          couponId: '222',
          sameCode: true,
          noTimesAllowed: '3',
          uniqueNoTimesAllowed: '1',
          usedCount: '1',
        });
      const { signature: _seal, ...body } = value;
      value.signature = couponHistoryHash(body as Omit<typeof facts, 'signature'>, historyKey);
      expect(() => assertQualifiedCouponHistory(value, facts.scope, historyKey, now)).toThrow();
    });
});
