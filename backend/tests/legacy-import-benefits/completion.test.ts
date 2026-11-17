import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { benefitFixture, now } from './fixture.js';
import {
  automaticCouponReceiptSchema,
  couponActivationSchema,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import { validateCsvFinancialBenefitSnapshot } from '../../src/modules/legacy-order-imports/benefit-profile/completion.js';
import { configuredCsvImportBenefits } from '../../src/modules/legacy-order-imports/benefit-profile/options.js';

function fixture(kind: 'offline' | 'shopify' = 'offline') {
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
      couponUsersBefore: [
        {
          id: '9007199254741600',
          allowed: '5',
          used: '0',
          monthlyAllowed: '5',
          inputHash: 'b'.repeat(64),
        },
      ],
      allocations: f.order.lines.map((line, index) => ({
        ...line,
        discount: index === 0 ? '20.00' : '0.00',
        refundable: index === 0 ? '180.00' : '0.00',
        refundInputHash: 'a'.repeat(64),
      })),
      refundAllocationContract: f.order.refundAllocationContract,
      refundSourcePatchHash: f.order.refundSourcePatchHash,
    }),
    activation = couponActivationSchema.parse({
      contract: 'pos-csv-coupon-consumption-v1',
      scope: { ...f.scope, method: 14 },
      stagedReceiptHash: 'c'.repeat(64),
      couponId: '222',
      sourceConfirmationHash: 'd'.repeat(64),
      changes: [{ id: '9007199254741600', before: '0', after: '1', inputHash: 'e'.repeat(64) }],
      log: { id: '9007199254741700', inputHash: 'f'.repeat(64), status: 1 },
    }),
    snapshot = {
      coupon: { receipt: coupon, sourceReceiptHash: 'c'.repeat(64) },
      complementary: { receipt: f.complementary.value, sourceReceiptHash: f.complementary.seal },
      activation:
        kind === 'offline' ? { receipt: activation, sourceReceiptHash: 'a'.repeat(64) } : null,
      confirmationHash: kind === 'offline' ? 'd'.repeat(64) : null,
    };
  return { f, snapshot, context: { ...f.state, kind, order: f.order } };
}
describe('immutable financial benefit completion after outer authentication', () => {
  it('preserves legacy field absence but enforces new frozen feature selections', () => {
    const value = fixture();
    expect(() =>
      validateCsvFinancialBenefitSnapshot(value.snapshot, {
        ...value.context,
        benefitContracts: { automaticCoupon: 'pos-csv-automatic-coupon-v1' },
      }),
    ).toThrow();
    expect(
      validateCsvFinancialBenefitSnapshot(value.snapshot, {
        ...value.context,
        benefitContracts: {
          automaticCoupon: 'pos-csv-automatic-coupon-v1',
          complementary: 'pos-csv-pos-complementary-v1',
        },
      }),
    ).toEqual(value.snapshot);
  });
  it('retains exact method14 consumption and method15 no-consumption evidence', () => {
    for (const kind of ['offline', 'shopify'] as const) {
      const value = fixture(kind);
      expect(validateCsvFinancialBenefitSnapshot(value.snapshot, value.context)).toEqual(
        value.snapshot,
      );
    }
  });
  it.each([
    'missing-consumption',
    'wrong-confirmation',
    'wrong-counter',
    'wrong-delta',
    'wrong-owner',
    'empty',
  ])('rejects %s even after an enclosing document is authenticated', (mutation) => {
    const value = fixture(),
      body = structuredClone(value.snapshot);
    if (mutation === 'missing-consumption') body.activation = null;
    if (mutation === 'wrong-confirmation') body.confirmationHash = 'a'.repeat(64);
    if (mutation === 'wrong-counter') body.activation!.receipt.scope.counterId = '99';
    if (mutation === 'wrong-delta') body.activation!.receipt.changes[0]!.before = '1';
    if (mutation === 'wrong-owner') body.complementary.receipt.selections[0]!.line.id = '99';
    const input =
      mutation === 'empty'
        ? {
            coupon: null,
            complementary: null,
            activation: null,
            confirmationHash: body.confirmationHash,
          }
        : body;
    expect(() => validateCsvFinancialBenefitSnapshot(input, value.context)).toThrow();
  });
  it('rejects a Shopify snapshot with an offline consumption record or confirmation hash', () => {
    const value = fixture('shopify'),
      offline = fixture();
    expect(() =>
      validateCsvFinancialBenefitSnapshot(
        {
          ...value.snapshot,
          activation: offline.snapshot.activation,
          confirmationHash: 'd'.repeat(64),
        },
        value.context,
      ),
    ).toThrow();
  });
});
describe('trusted Node benefit configuration', () => {
  it('leaves profiles unselected without inventing proof keys or contract defaults', () => {
    const value = configuredCsvImportBenefits({}, {});
    expect(value).toEqual({ ready: true, options: { sourceProofKey: '' }, guard: undefined });
  });
  it.each([
    { POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT: 'wrong' },
    { POS_LEGACY_IMPORT_COMPLEMENTARY_CONTRACT: 'pos-csv-pos-complementary-v1' },
  ])(
    'installs a pure new-work refusal while retaining recovery for invalid settings',
    (environment) => {
      const value = configuredCsvImportBenefits({}, environment);
      expect(value.ready).toBe(false);
      expect(() => value.guard?.assertReady?.(benefitFixture().plan)).toThrow();
    },
  );
});
