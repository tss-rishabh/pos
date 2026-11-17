import { randomUUID } from 'node:crypto';
import {
  importFinancialStateSchema,
  sourceOrderReceiptSchema,
} from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  benefitAuthorityHash,
  benefitReceiptHash,
  posComplementaryReceiptSchema,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import type { LegacyOrderImportPlan } from '../../src/modules/legacy-order-imports/plans.js';
import {
  couponHistoryHash,
  qualifiedCouponHistorySchema,
} from '../../src/modules/legacy-order-imports/benefit-profile/history.js';

export const sourceKey = 'isolated-csv-benefit-source-proof-'.repeat(3),
  historyKey = 'isolated-csv-benefit-history-proof-'.repeat(3),
  memberKey = 'isolated-csv-benefit-member-proof-'.repeat(3),
  asOf = '2026-06-15 12:00:00',
  now = Date.parse('2026-06-15T06:30:00Z');
export function benefitFixture(kind: 'offline' | 'shopify' = 'offline') {
  const operationId = randomUUID();
  const state = importFinancialStateSchema.parse({
    scope: { actorId: '44', operationId, storeId: '1', counterId: '3' },
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
    stage: 'order',
    orderId: '5001',
    errorCode: null,
    requestId: 'isolated-benefit',
    createdAt: now,
    updatedAt: now,
  });
  const common = {
    sequence: 1,
    firstRow: 2,
    reference: 'original-csv-fixture',
    storeId: '1',
    email: 'fixture@example.test',
    createdAt: '2020-01-15 12:00:00',
    originalTenderAmount: '253.49',
    lines: [
      { productId: '9007199254740993', quantity: 2, unitPrice: '100.00', sourceRows: [2] },
      { productId: '9007199254740994', quantity: 3, unitPrice: '17.83', sourceRows: [3] },
    ],
  };
  const plan: LegacyOrderImportPlan =
    kind === 'offline'
      ? { ...common, kind, payment: 'cash', sendOrderPlacedSms: false, message: '' }
      : {
          ...common,
          kind,
          payment: 'shopify',
          email: common.email,
          currency: 'INR',
          address: {},
          legacyTaxDigit: 0,
          shippingCharges: '0.00',
          discountAmount: '0.00',
          financialStatus: 'paid',
          declaredSubtotal: '253.49',
          declaredTaxes: '0.00',
          declaredTotal: '253.49',
        };
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
    lineHash: 'd'.repeat(64),
    method: kind === 'offline' ? 14 : 15,
    payable: '180.00',
    refundAllocationContract: 'pos-refund-per-hp-v1',
    refundSourcePatchHash: 'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
    sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
    sourceControllerHash: 'd8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18',
    lineItemsEnabled: false,
    lines: [
      {
        id: '9007199254741001',
        productId: common.lines[0]!.productId,
        quantity: 2,
        inputHash: '1'.repeat(64),
      },
      {
        id: '9007199254741002',
        productId: common.lines[1]!.productId,
        quantity: 1,
        inputHash: '2'.repeat(64),
      },
    ],
    effectsHash: 'e'.repeat(64),
  });
  const scope = {
    operationId,
    requestHash: state.requestHash,
    planHash: state.planHash,
    actorId: state.scope.actorId,
    authorityHash: benefitAuthorityHash(state, sourceKey),
    namespace: state.namespace,
    orderId: order.orderId,
    customerId: order.customerId,
    storeId: order.storeId,
    counterId: order.counterId,
    method: order.method,
    sourceCommit: order.sourceCommit,
    headerHash: order.headerHash,
    lineHash: order.lineHash,
    asOf,
  };
  const selected = plan.lines[1]!;
  const complementary = posComplementaryReceiptSchema.parse({
    contract: 'pos-csv-pos-complementary-v1',
    scope,
    origin: 'original-csv-pos-selection',
    selections: [
      {
        productId: selected.productId,
        declaredQuantity: selected.quantity,
        declaredUnitPrice: selected.unitPrice,
        sourceRows: selected.sourceRows,
        productInputHash: '3'.repeat(64),
        catalogBasePrice: '0.00',
        priceRule: 'source-base-aggregate',
        line: {
          ...order.lines[1]!,
          quantity: 1,
          price: '0.00',
          type: 'FREEBIE',
          refundable: '0.00',
          refundInputHash: '4'.repeat(64),
        },
        grant: {
          id: '9007199254741100',
          inputHash: '5'.repeat(64),
          level: 'POS_MANUAL',
          triggerKey: 'pos_manual:0',
          status: 'ACTIVE',
          triggerCount: 0,
        },
      },
    ],
    additionalLines: [],
  });
  return {
    state,
    plan,
    order,
    scope,
    sourceProofKey: sourceKey,
    complementary: {
      value: complementary,
      seal: benefitReceiptHash('complementary', complementary, sourceKey),
    },
  };
}
export function historyFixture() {
  const f = benefitFixture();
  const value = qualifiedCouponHistorySchema.parse({
    scope: {
      contract: 'pos-csv-coupon-history-v1',
      operationId: f.state.scope.operationId,
      requestHash: f.state.requestHash,
      planHash: f.state.planHash,
      customerId: '77',
      couponId: '222',
      configurationHash: '6'.repeat(64),
      asOf,
      sourceTimeZone: 'Asia/Kolkata',
    },
    reader: 'bigquery',
    generationId: '7'.repeat(64),
    complete: true,
    fetchedAt: now,
    publication: {
      sourceCaptureHash: '8'.repeat(64),
      controlHeadHash: '9'.repeat(64),
      queryContract: 'pos-source-coupon-selects-2960-v1',
      seal: '0'.repeat(64),
    },
    globalUsage: '3',
    birthdayTodayUsage: '0',
    customerOrderCount: '0',
    monthlyJoinedUsage: '0',
    lotCounts: [],
    signature: '0'.repeat(64),
  });
  const { signature: _seal, ...body } = value;
  value.signature = couponHistoryHash(body, historyKey);
  return value;
}
