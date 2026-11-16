import { cashDigest } from '../../src/modules/checkout/offline-cash/crypto.js';
import { cashLines, cashTotals } from '../../src/modules/checkout/offline-cash/domain.js';
import type {
  CashAuthorization,
  CashPriceSnapshot,
  CashReceipt,
} from '../../src/modules/checkout/offline-cash/contracts.js';

export function offlineCashFixture() {
  const snapshot: CashPriceSnapshot = {
    version: 1,
    id: 'c09c3a87-bbc8-4fd0-bfbd-f1681e285487',
    storeId: '1',
    counterId: '2',
    businessDate: '2026-11-16',
    issuedAt: 1_794_796_200_000,
    expiresAt: 1_794_796_800_000,
    sourceContract: 'pos-offline-cash-prices-v1',
    sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
    sourceSettingsHash: '1'.repeat(64),
    locationSettingsHash: '2'.repeat(64),
    lineItemsEnabled: true,
    excludedProductIds: [],
    products: [
      {
        productId: '9007199254740993',
        name: 'Source-priced product',
        barcode: 'FIXTURE',
        hsn: '6109',
        cachedStock: 2,
        quantities: [
          {
            quantity: 1,
            unitPrice: '199.99',
            mainSubtotalCents: 19999,
            taxableCents: 19047,
            taxCents: 952,
            invoiceGst: '5',
          },
          {
            quantity: 2,
            unitPrice: '199.99',
            mainSubtotalCents: 39998,
            taxableCents: 38093,
            taxCents: 1905,
            invoiceGst: '5',
          },
        ],
      },
    ],
  };
  const authorization: CashAuthorization = {
    version: 1,
    id: '65b5c07c-b7a6-4a58-bcd3-991df3fca36a',
    deviceId: '48d71dd8-c2fa-442b-b983-12c2593408af',
    deviceKeyHash: '4'.repeat(64),
    operatorId: '44',
    operatorAuthVersion: '3'.repeat(64),
    operatorCustomerId: '777',
    storeId: '1',
    counterId: '2',
    businessDate: snapshot.businessDate,
    issuedAt: snapshot.issuedAt,
    expiresAt: snapshot.expiresAt,
    snapshotId: snapshot.id,
    snapshotHash: cashDigest(snapshot),
    stockPolicy: 'cached-stock-manager',
    mode: 'cash-only',
    currency: 'INR',
    receiptPrefix: 'OC-65B5C07CB7A64A58BCD3991DF3FCA36A',
    receiptCount: 100,
    maxReceiptUnits: 1000,
    maxReceiptCents: 100000,
    maxTotalCents: 1000000,
  };
  const lines = cashLines(snapshot, [{ productId: '9007199254740993', quantity: 2 }]);
  const receipt: CashReceipt = {
    version: 1,
    id: '16537dc0-22c9-4697-8023-870c7154a9ab',
    authorizationId: authorization.id,
    deviceId: authorization.deviceId,
    operatorId: authorization.operatorId,
    storeId: '1',
    counterId: '2',
    businessDate: snapshot.businessDate,
    draftId: 'b45a588c-3826-4cf7-80a3-deee926fdcf4',
    draftVersion: snapshot.issuedAt,
    sequence: 1,
    receiptNumber: authorization.receiptPrefix + '-0001',
    completedAt: snapshot.issuedAt + 1000,
    currency: 'INR',
    snapshotId: snapshot.id,
    snapshotHash: authorization.snapshotHash,
    stockPolicy: 'cached-stock-manager',
    lines,
    ...cashTotals(lines),
    cashReceivedCents: 50000,
    changeCents: 10100,
  };
  return { snapshot, authorization, receipt };
}
