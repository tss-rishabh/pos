import { randomUUID } from 'node:crypto';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import {
  importFinancialStateSchema,
  sourceOrderReceiptSchema,
} from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  csvMembershipContract,
  csvMembershipReceiptHash,
  csvMembershipReceiptSchema,
  membershipProvenanceHash,
} from '../../src/modules/legacy-order-imports/membership-profile/domain.js';
import type { CsvMembershipOptions } from '../../src/modules/legacy-order-imports/membership-profile/native.js';
import type { LegacyOrderImportPlan } from '../../src/modules/legacy-order-imports/plans.js';
export const adapterOptions: CsvMembershipOptions = {
  contract: csvMembershipContract,
  freshReaderContract: 'pos-membership-fresh-reader-v1',
  sourceProofKey: 'isolated-csv-adapter-source-key-01234567890123456789',
  membershipProofKey: 'isolated-csv-adapter-member-key-01234567890123456789',
  productIds: ['10', '12'],
  freeProductId: '12',
};
/** Synthetic product IDs are an explicit trusted fixture registry, never defaults. */
export function memberEvidence(kind: 'offline' | 'shopify' = 'offline', free = false) {
  const operationId = randomUUID(),
    state = importFinancialStateSchema.parse({
      scope: { actorId: '1', operationId, storeId: '1', counterId: '2' },
      planHash: 'b'.repeat(64),
      requestHash: 'a'.repeat(64),
      namespace: 'pos-import-v1:' + operationId,
      authority: {
        customerId: '77',
        contact: { revision: '0', digest: 'f'.repeat(64) },
        actorVersion: 'e'.repeat(64),
        actorEpoch: '0',
        approvalId: null,
        close: null,
      },
      status: 'running',
      stage: 'confirmation',
      orderId: '5001',
      errorCode: null,
      requestId: 'isolated-member-adapter',
      createdAt: 1781505000000,
      updatedAt: 1781505000000,
    });
  const common = {
      sequence: 1,
      firstRow: 2,
      reference: randomUUID(),
      storeId: '1',
      email: 'private-import@example.test',
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
    },
    plan: LegacyOrderImportPlan =
      kind === 'offline'
        ? { ...common, kind, payment: 'cash', sendOrderPlacedSms: false, message: '' }
        : {
            ...common,
            kind,
            payment: 'shopify',
            currency: 'INR',
            address: { shipping_name: 'Fixture' },
            legacyTaxDigit: 1,
            shippingCharges: '0.00',
            discountAmount: '0.00',
            financialStatus: 'paid',
            declaredSubtotal: common.originalTenderAmount,
            declaredTaxes: '0.00',
            declaredTotal: common.originalTenderAmount,
          },
    member = {
      id: '6001',
      productId: free ? '12' : '10',
      quantity: 1 as const,
      inputHash: 'd'.repeat(64),
    },
    order = sourceOrderReceiptSchema.parse({
      contract: 'pos-legacy-order-import-source-v1',
      operationId,
      requestHash: state.requestHash,
      namespace: state.namespace,
      customerId: '77',
      storeId: '1',
      counterId: '2',
      createdAt: plan.createdAt,
      orderId: '5001',
      headerHash: 'c'.repeat(64),
      lineHash: 'c'.repeat(64),
      method: kind === 'offline' ? 14 : 15,
      payable: plan.originalTenderAmount,
      refundAllocationContract: 'pos-refund-per-hp-v1',
      refundSourcePatchHash: 'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
      sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
      sourceControllerHash: 'd8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18',
      lineItemsEnabled: false,
      lines: free
        ? [member, { id: '6002', productId: '11', quantity: 1, inputHash: 'e'.repeat(64) }]
        : [member],
      effectsHash: 'd'.repeat(64),
    });
  const receipt = csvMembershipReceiptSchema.parse({
    contract: csvMembershipContract,
    operationId,
    requestHash: state.requestHash,
    planHash: state.planHash,
    actorId: state.scope.actorId,
    authorityHash: operationHash(
      'legacy-order-imports.source.membership-authority.v1',
      state.authority,
      adapterOptions.sourceProofKey,
    ),
    namespace: state.namespace,
    orderId: order.orderId,
    customerId: order.customerId,
    storeId: order.storeId,
    counterId: order.counterId,
    method: order.method,
    sourceCommit: order.sourceCommit,
    kind: free ? 'auto-free' : 'new',
    eligibility: free ? 'source-cart-over-2000' : 'no-ordinary-items',
    headerHash: order.headerHash,
    lineHash: order.lineHash,
    memberLines: [member],
    additionalLines: free ? [member] : [],
    provenance: {
      orderId: order.orderId,
      customerId: order.customerId,
      revision: '2',
      headerHash: 'e'.repeat(64),
      before: [],
      confirmed: [
        {
          attribute: 'EXCLUSIVE_EXPIRY',
          value: '2027-06-15T12:00:00',
          active: 0,
          createdAt: plan.createdAt,
          updatedAt: plan.createdAt,
          hash: 'd'.repeat(64),
        },
        {
          attribute: 'EXCLUSIVE_MEMBER',
          value: '1',
          active: 0,
          createdAt: plan.createdAt,
          updatedAt: plan.createdAt,
          hash: 'e'.repeat(64),
        },
      ],
      contract: 'pos-cancellation-membership-staged-v2',
      operationId: randomUUID(),
      createdAt: plan.createdAt,
      entityDigest: operationHash(
        'pending-cancellation.membership-entity.v1',
        plan.email,
        adapterOptions.membershipProofKey,
      ),
      proofHash: '0'.repeat(64),
    },
    cacheInvalidations: 1,
  });
  receipt.provenance.proofHash = membershipProvenanceHash(
    receipt.provenance,
    adapterOptions.membershipProofKey,
  );
  return {
    state,
    plan,
    order,
    snapshot: {
      receipt,
      sourceReceiptHash: csvMembershipReceiptHash(receipt, adapterOptions.sourceProofKey),
    },
  };
}
