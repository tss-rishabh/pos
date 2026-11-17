import { describe, expect, it } from 'vitest';
import { adapterOptions, memberEvidence } from './adapter-fixtures.js';
import {
  csvMembershipReceiptHash,
  csvMembershipReceiptSchema,
  verifyCsvMembershipDescriptor,
} from '../../src/modules/legacy-order-imports/membership-profile/domain.js';
import { validateCsvMembershipCompletionSnapshot } from '../../src/modules/legacy-order-imports/membership-profile/completion.js';
import { verifyCsvBenefitComposition } from '../../src/modules/legacy-order-imports/benefit-profile/ownership.js';
import { amount, minorUnits } from '../../src/domain/money.js';

function replacementEvidence(kind: 'offline' | 'shopify', history = false) {
  const f = memberEvidence(kind, true),
    ordinary = history ? '25.49' : '2300.00',
    original = { productId: '10', quantity: 1 as const, unitPrice: '100.00', sourceRows: [2] };
  f.plan.lines = [original, { productId: '11', quantity: 1, unitPrice: ordinary, sourceRows: [3] }];
  f.plan.originalTenderAmount = amount(minorUnits(ordinary) + 10000n);
  f.order.payable = history ? '25.00' : ordinary;
  const receipt = f.snapshot.receipt;
  receipt.replacement = {
    contract: 'pos-csv-membership-replacement-v1',
    sourceAction: 'AddFreeMembership.remove_exclusive_membership',
    originalLine: structuredClone(original),
    memberLine: { ...receipt.memberLines[0]! },
  };
  if (history) {
    receipt.eligibility = 'source-qualified-history';
    receipt.historyEvidence = {
      generationId: 'f'.repeat(64),
      fetchedAt: Date.parse('2026-11-17T06:30:03Z'),
      asOf: '2026-11-17 12:00:03',
      cutoff: '2026-10-03 12:00:03',
      proofHash: 'e'.repeat(64),
    };
  }
  const seal = () => {
    f.snapshot.sourceReceiptHash = csvMembershipReceiptHash(receipt, adapterOptions.sourceProofKey);
  };
  seal();
  const verify = () =>
    verifyCsvMembershipDescriptor({
      state: f.state,
      plan: f.plan,
      order: f.order,
      value: receipt,
      seal: f.snapshot.sourceReceiptHash,
      ...adapterOptions,
    });
  return { ...f, receipt, seal, verify };
}

describe('explicit source membership SKU replacement', () => {
  it.each(['offline', 'shopify'] as const)(
    'preserves the original %s plan while admitting only the source-replaced HP quantities',
    (kind) => {
      for (const history of [false, true]) {
        const f = replacementEvidence(kind, history),
          original = structuredClone(f.plan);
        expect(f.verify().expectedQuantities).toEqual(
          new Map([
            ['11', 1],
            ['12', 1],
          ]),
        );
        expect(f.plan).toEqual(original);
        expect(f.plan.lines.map((row) => row.productId)).toEqual(['10', '11']);
        expect(f.order.lines.map((row) => row.productId)).toEqual(['12', '11']);
      }
    },
  );
  it.each(['price', 'quantity', 'rows', 'product', 'free-product', 'member-line', 'source-action'])(
    'rejects changed %s even when a new descriptor is signed with the source key',
    (change) => {
      const f = replacementEvidence('offline');
      const replacement = f.receipt.replacement!;
      if (change === 'price') replacement.originalLine.unitPrice = '99.99';
      if (change === 'quantity') Object.assign(replacement.originalLine, { quantity: 2 });
      if (change === 'rows') replacement.originalLine.sourceRows = [4];
      if (change === 'product') replacement.originalLine.productId = '11';
      if (change === 'free-product') replacement.originalLine.productId = '12';
      if (change === 'member-line') replacement.memberLine.id = '7001';
      if (change === 'source-action') Object.assign(replacement, { sourceAction: 'inferred' });
      f.seal();
      expect(f.verify).toThrow();
    },
  );
  it('refuses removal inferred only from equal final quantities or an unqualified original member', () => {
    const f = replacementEvidence('offline');
    delete f.receipt.replacement;
    f.seal();
    expect(f.verify).toThrow();
    const ordinary = replacementEvidence('offline');
    ordinary.plan.lines[0]!.productId = '13';
    ordinary.receipt.replacement!.originalLine.productId = '13';
    ordinary.seal();
    expect(ordinary.verify).toThrow();
  });
  it('does not accept a retained original HP or two planned membership lines', () => {
    const f = replacementEvidence('offline');
    f.order.lines.push({ id: '7001', productId: '10', quantity: 1, inputHash: 'f'.repeat(64) });
    expect(f.verify).toThrow();
    const another = replacementEvidence('offline');
    another.plan.lines.push({ productId: '12', quantity: 1, unitPrice: '0.00', sourceRows: [4] });
    expect(another.verify).toThrow();
  });
  it('retains replacement ownership and the distinct Shopify original-plan stock scope', () => {
    for (const kind of ['offline', 'shopify'] as const) {
      const f = replacementEvidence(kind),
        composition = verifyCsvBenefitComposition({
          ...f,
          sourceProofKey: adapterOptions.sourceProofKey,
          membership: {
            value: f.receipt,
            seal: f.snapshot.sourceReceiptHash,
            membershipProofKey: adapterOptions.membershipProofKey,
            productIds: adapterOptions.productIds,
            freeProductId: adapterOptions.freeProductId,
          },
        });
      expect(composition.ownership.map((row) => [row.productId, row.owner])).toEqual([
        ['12', 'membership'],
        ['11', 'original-plan'],
      ]);
      expect(composition.stock.lines.map((row) => row.productId)).toEqual(
        kind === 'shopify' ? ['10', '11'] : ['12', '11'],
      );
    }
  });
  it('reads a frozen replacement after the enclosing seal without current catalog/member keys', () => {
    const f = replacementEvidence('offline', true),
      completed = { ...f.state, kind: f.plan.kind, order: f.order };
    expect(validateCsvMembershipCompletionSnapshot(f.snapshot, completed)).toEqual(f.snapshot);
    f.snapshot.receipt.replacement!.memberLine.id = '7001';
    expect(() => validateCsvMembershipCompletionSnapshot(f.snapshot, completed)).toThrow();
  });
  it('preserves optional-field absence and the signed bytes of existing source descriptors', () => {
    const f = memberEvidence('offline', true),
      original = structuredClone(f.snapshot.receipt),
      parsed = csvMembershipReceiptSchema.parse(original);
    expect(parsed).not.toHaveProperty('replacement');
    expect(csvMembershipReceiptHash(parsed, adapterOptions.sourceProofKey)).toBe(
      csvMembershipReceiptHash(original, adapterOptions.sourceProofKey),
    );
  });
});
