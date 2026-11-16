import { AppError } from '../../../domain/errors.js';
import { cashDigest } from './crypto.js';
import * as evidence from './evidence.js';
import type { CashAuthorization, CashPriceSnapshot, CashReceipt } from './contracts.js';

export { cashLines, cashTotals } from './evidence.js';
function checked<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof evidence.CashEvidenceError)
      throw new AppError(409, 'OFFLINE_CASH_EVIDENCE_MISMATCH', error.message);
    throw error;
  }
}
export function assertCashSnapshot(authorization: CashAuthorization, snapshot: CashPriceSnapshot) {
  return checked(() => evidence.assertCashSnapshot(authorization, snapshot, cashDigest(snapshot)));
}
export function assertCashReceipt(
  authorization: CashAuthorization,
  snapshot: CashPriceSnapshot,
  receipt: CashReceipt,
) {
  return checked(() =>
    evidence.assertCashReceipt(authorization, snapshot, receipt, cashDigest(snapshot)),
  );
}
