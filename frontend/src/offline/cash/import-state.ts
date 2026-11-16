import type { CashReceiptAcceptance } from './contracts';
import type { LocalCashOrderImport } from './storage-types';

/** Called only after the server evidence matches the original immutable cash receipt. */
export function reconcileCashOrderImport(
  intent: LocalCashOrderImport,
  accepted: CashReceiptAcceptance,
): LocalCashOrderImport {
  if (accepted.status === 'imported')
    return { ...intent, state: 'confirmed', attemptId: null, errorCode: null };
  if (
    accepted.status !== 'accepted' ||
    accepted.conflicts.length ||
    accepted.version !== intent.expectedVersion
  )
    return {
      ...intent,
      state: 'blocked',
      attemptId: null,
      errorCode: 'OFFLINE_CASH_MANAGER_REVIEW_REQUIRED',
    };
  return intent;
}
