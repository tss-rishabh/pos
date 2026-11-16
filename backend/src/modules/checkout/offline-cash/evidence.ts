import { canonicalCashJson } from './canonical.js';
import {
  cashAuthorizationSchema,
  cashPriceSnapshotSchema,
  cashReceiptSchema,
  MAX_CASH_CENTS,
  type CashAuthorization,
  type CashConflict,
  type CashPriceSnapshot,
  type CashReceipt,
} from './contracts.js';

export class CashEvidenceError extends Error {}
function invalid(message = 'The offline cash evidence does not match its authorization.'): never {
  throw new CashEvidenceError(message);
}

export function cashLines(
  snapshot: CashPriceSnapshot,
  selections: { productId: string; quantity: number }[],
) {
  if (
    !selections.length ||
    selections.length > 100 ||
    selections.reduce((total, line) => total + line.quantity, 0) > 1000 ||
    new Set(selections.map((entry) => entry.productId)).size !== selections.length
  )
    invalid();
  return selections.map((selection) => {
    const product = snapshot.products.find((entry) => entry.productId === selection.productId),
      price = product?.quantities.find((entry) => entry.quantity === selection.quantity);
    if (!product || !price)
      invalid('A source-authorized price for this product and quantity is not cached.');
    return {
      ...price,
      productId: product.productId,
      name: product.name,
      barcode: product.barcode,
      hsn: product.hsn,
    };
  });
}

export function cashTotals(lines: CashReceipt['lines']) {
  const taxableCents = lines.reduce((sum, line) => sum + line.taxableCents, 0),
    taxCents = lines.reduce((sum, line) => sum + line.taxCents, 0),
    total = taxableCents + taxCents;
  if (!Number.isSafeInteger(total) || total > MAX_CASH_CENTS) invalid();
  // Pinned CalculationsWrapper: sum source-rounded line taxable/tax amounts,
  // round total to cents, then math.floor rupees. No GST formula runs here.
  const roundingCents = total % 100;
  return { taxableCents, taxCents, roundingCents, payableCents: total - roundingCents };
}

export function assertCashSnapshot(
  authorization: CashAuthorization,
  snapshot: CashPriceSnapshot,
  snapshotHash: string,
) {
  const grant = cashAuthorizationSchema.parse(authorization),
    prices = cashPriceSnapshotSchema.parse(snapshot);
  if (
    grant.snapshotId !== prices.id ||
    grant.snapshotHash !== snapshotHash ||
    grant.storeId !== prices.storeId ||
    grant.counterId !== prices.counterId ||
    grant.businessDate !== prices.businessDate ||
    grant.issuedAt < prices.issuedAt ||
    grant.expiresAt > prices.expiresAt
  )
    invalid();
  return { authorization: grant, snapshot: prices };
}

/** Valid cash evidence stays immutable even if live access/stock later changes. */
export function assertCashReceipt(
  authorization: CashAuthorization,
  snapshot: CashPriceSnapshot,
  supplied: CashReceipt,
  snapshotHash: string,
): CashConflict[] {
  const { authorization: grant, snapshot: prices } = assertCashSnapshot(
      authorization,
      snapshot,
      snapshotHash,
    ),
    receipt = cashReceiptSchema.parse(supplied);
  for (const field of [
    'deviceId',
    'operatorId',
    'storeId',
    'counterId',
    'businessDate',
    'currency',
    'snapshotId',
    'snapshotHash',
    'stockPolicy',
  ] as const)
    if (receipt[field] !== grant[field]) invalid();
  if (
    receipt.authorizationId !== grant.id ||
    receipt.sequence > grant.receiptCount ||
    receipt.receiptNumber !==
      `${grant.receiptPrefix}-${String(receipt.sequence).padStart(4, '0')}` ||
    receipt.payableCents > grant.maxReceiptCents ||
    receipt.cashReceivedCents - receipt.changeCents !== receipt.payableCents
  )
    invalid();
  const expectedLines = cashLines(prices, receipt.lines);
  if (canonicalCashJson(expectedLines) !== canonicalCashJson(receipt.lines)) invalid();
  const totals = cashTotals(expectedLines);
  for (const field of ['taxableCents', 'taxCents', 'roundingCents', 'payableCents'] as const)
    if (receipt[field] !== totals[field]) invalid();
  const conflicts: CashConflict[] = [];
  if (receipt.completedAt < grant.issuedAt || receipt.completedAt > grant.expiresAt)
    conflicts.push('clock-outside-authorization');
  if (receipt.completedAt > prices.expiresAt) conflicts.push('price-snapshot-expired');
  return conflicts;
}
