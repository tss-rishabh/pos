import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import {
  csvMembershipContract,
  csvMembershipReceiptHash,
  csvMembershipReceiptSchema,
  membershipProvenanceHash,
  verifyCsvMembershipDescriptor,
} from '../../src/modules/legacy-order-imports/membership-profile/domain.js';
import {
  importFinancialStateSchema,
  sourceOrderReceiptSchema,
} from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import type { LegacyOrderImportPlan } from '../../src/modules/legacy-order-imports/plans.js';

const sourceProofKey = 'isolated-source-membership-proof-key-0123456789',
  membershipProofKey = 'isolated-ordinary-membership-proof-key-0123456789';
function fixture(free = false) {
  const operationId = randomUUID(),
    scope = { actorId: '44', operationId, storeId: '1', counterId: '3' };
  const state = importFinancialStateSchema.parse({
    scope,
    authority: {
      customerId: '77',
      contact: { revision: '0', digest: 'f'.repeat(64) },
      actorVersion: 'e'.repeat(64),
      actorEpoch: '0',
      approvalId: null,
      close: null,
    },
    planHash: 'b'.repeat(64),
    requestHash: 'a'.repeat(64),
    namespace: 'pos-import-v1:' + operationId,
    status: 'running',
    stage: 'confirmation',
    orderId: '5001',
    errorCode: null,
    requestId: 'isolated-membership',
    createdAt: 1781505000000,
    updatedAt: 1781505000000,
  });
  const plan: LegacyOrderImportPlan = {
    sequence: 1,
    firstRow: 2,
    reference: 'original-csv-reference',
    storeId: '1',
    email: 'fixture@example.test',
    createdAt: '2026-06-15 12:00:00',
    lines: [
      {
        productId: free ? '11' : '10',
        quantity: 1,
        unitPrice: free ? '2300.00' : '100.00',
        sourceRows: [2],
      },
    ],
    originalTenderAmount: free ? '2300.00' : '100.00',
    kind: 'offline',
    payment: 'cash',
    sendOrderPlacedSms: false,
    message: '',
  };
  const member = { id: '6001', productId: '10', quantity: 1 as const, inputHash: 'd'.repeat(64) };
  const order = sourceOrderReceiptSchema.parse({
    contract: 'pos-legacy-order-import-source-v1',
    operationId,
    requestHash: state.requestHash,
    namespace: state.namespace,
    customerId: '77',
    storeId: '1',
    counterId: '3',
    createdAt: plan.createdAt,
    orderId: '5001',
    headerHash: 'c'.repeat(64),
    lineHash: 'c'.repeat(64),
    method: 14,
    payable: plan.originalTenderAmount,
    refundAllocationContract: 'pos-refund-per-hp-v1',
    refundSourcePatchHash: 'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
    sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
    sourceControllerHash: 'd8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18',
    lineItemsEnabled: false,
    lines: free
      ? [member, { id: '6002', productId: '11', quantity: 1, inputHash: 'd'.repeat(64) }]
      : [member],
    effectsHash: 'd'.repeat(64),
  });
  const confirmed = [
    {
      attribute: 'EXCLUSIVE_EXPIRY' as const,
      value: '2027-06-15T12:00:00',
      active: 0,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
      hash: 'd'.repeat(64),
    },
    {
      attribute: 'EXCLUSIVE_MEMBER' as const,
      value: '1',
      active: 0,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
      hash: 'e'.repeat(64),
    },
  ];
  const provenance = {
    orderId: '5001',
    customerId: '77',
    revision: '3',
    headerHash: 'e'.repeat(64),
    before: [],
    confirmed,
    contract: 'pos-cancellation-membership-staged-v2' as const,
    operationId: randomUUID(),
    createdAt: plan.createdAt,
    entityDigest: operationHash(
      'pending-cancellation.membership-entity.v1',
      plan.email,
      membershipProofKey,
    ),
    proofHash: '',
  };
  provenance.proofHash = membershipProvenanceHash(provenance, membershipProofKey);
  const value = csvMembershipReceiptSchema.parse({
    contract: csvMembershipContract,
    actorId: state.scope.actorId,
    authorityHash: operationHash(
      'legacy-order-imports.source.membership-authority.v1',
      state.authority,
      sourceProofKey,
    ),
    operationId,
    requestHash: state.requestHash,
    planHash: state.planHash,
    namespace: state.namespace,
    orderId: '5001',
    customerId: '77',
    storeId: '1',
    counterId: '3',
    method: 14,
    sourceCommit: order.sourceCommit,
    kind: free ? 'auto-free' : 'new',
    eligibility: free ? 'source-cart-over-2000' : 'no-ordinary-items',
    headerHash: order.headerHash,
    lineHash: order.lineHash,
    memberLines: [member],
    additionalLines: free ? [member] : [],
    provenance,
    cacheInvalidations: 1,
  });
  return {
    state,
    plan,
    order,
    value,
    seal: csvMembershipReceiptHash(value, sourceProofKey),
    sourceProofKey,
    membershipProofKey,
    productIds: ['10'],
    freeProductId: '10',
  };
}

describe('private CSV source-qualified membership descriptor', () => {
  it('keeps planned member and explicit source free additions separate', () => {
    expect(verifyCsvMembershipDescriptor(fixture()).expectedQuantities).toEqual(
      new Map([['10', 1]]),
    );
    expect(verifyCsvMembershipDescriptor(fixture(true)).expectedQuantities).toEqual(
      new Map([
        ['11', 1],
        ['10', 1],
      ]),
    );
  });
  for (const key of [
    'actorId',
    'authorityHash',
    'operationId',
    'requestHash',
    'planHash',
    'namespace',
    'orderId',
    'customerId',
    'storeId',
    'counterId',
    'method',
    'headerHash',
    'lineHash',
    'sourceCommit',
  ] as const)
    it(`rejects changed ${key} even with a newly signed descriptor`, () => {
      const input = fixture(true);
      const value: Record<string, unknown> = { ...input.value };
      value[key] =
        key === 'method'
          ? 15
          : key === 'operationId'
            ? randomUUID()
            : key === 'namespace'
              ? 'pos-import-v1:' + randomUUID()
              : key === 'sourceCommit'
                ? '0'.repeat(40)
                : key.endsWith('Hash')
                  ? 'f'.repeat(64)
                  : '88';
      const seal = operationHash(
        'legacy-order-imports.source.membership.v1',
        value,
        sourceProofKey,
      );
      expect(() => verifyCsvMembershipDescriptor({ ...input, value, seal })).toThrow();
    });
  it('requires original independent ordinary-producer provenance signature', () => {
    const input = fixture();
    input.value.provenance.before = [
      { ...input.value.provenance.confirmed[0]!, active: 1 },
      { ...input.value.provenance.confirmed[1]!, active: 1 },
    ];
    input.seal = csvMembershipReceiptHash(input.value, sourceProofKey);
    expect(() => verifyCsvMembershipDescriptor(input)).toThrow();
  });
  it('refuses undocumented products, changed planned quantities and fabricated auto causality', () => {
    for (const mode of ['extra', 'quantity', 'causality']) {
      const input = fixture(true);
      if (mode === 'extra')
        input.order.lines.push({
          id: '6003',
          productId: '12',
          quantity: 1,
          inputHash: 'd'.repeat(64),
        });
      if (mode === 'quantity') input.plan.lines[0]!.quantity = 2;
      if (mode === 'causality') input.value.eligibility = 'not-added';
      expect(() =>
        verifyCsvMembershipDescriptor({
          ...input,
          seal: operationHash(
            'legacy-order-imports.source.membership.v1',
            input.value,
            sourceProofKey,
          ),
        }),
      ).toThrow();
    }
  });
  it('does not manufacture method14 confirmation for method15 Shopify staging', () => {
    const input = fixture();
    expect(() =>
      verifyCsvMembershipDescriptor({ ...input, order: { ...input.order, method: 15 } }),
    ).toThrow();
  });
});
