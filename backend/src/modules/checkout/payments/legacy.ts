import { AppError } from '../../../domain/errors.js';
import { amount, minorUnits } from '../../../domain/money.js';
import type { PaymentAttempt, PaymentInput } from './contracts.js';
import { operationHash } from '../crypto.js';

/** Minimal source facts only; raw provider responses and credentials are never loaded. */
export interface LegacyTerminalRecord {
  provider: 'pine' | 'paytm';
  id: string;
  storeId: string;
  transactionId: string;
  providerReference: string | null;
  storePosCode: string;
  imei: string;
  mid: string;
  tid: string;
  onlineAmount: string;
  cashAmount: string;
  cashReceived: string;
  paymentMode: number;
  platform: string;
}
/** Stable field contract. ORM aliases/raw provider responses never enter new hashes. */
export function legacyPaymentSourceHash(record: LegacyTerminalRecord, secret: string, version?: 1) {
  const fields = {
    provider: record.provider,
    id: record.id,
    storeId: record.storeId,
    transactionId: record.transactionId,
    providerReference: record.providerReference,
    storePosCode: record.storePosCode,
    imei: record.imei,
    mid: record.mid,
    tid: record.tid,
    onlineAmount: record.onlineAmount,
    cashAmount: record.cashAmount,
    cashReceived: record.cashReceived,
    paymentMode: record.paymentMode,
    platform: record.platform,
  };
  if (version === 1)
    return operationHash('payment.legacy.source.v1', { version, ...fields }, secret);
  // Compatibility with the initial, undeployed unversioned record shape. Rebuild
  // its two Pine aliases explicitly instead of depending on a SELECT spread.
  return operationHash(
    'payment.legacy.source',
    record.provider === 'pine'
      ? { ...fields, reference: record.providerReference ?? '', code: record.storePosCode }
      : fields,
    secret,
  );
}
export function legacyChannel(row: LegacyTerminalRecord): PaymentInput['channel'] {
  const channel =
    row.provider === 'pine'
      ? row.paymentMode === 1
        ? 'pine-card'
        : row.paymentMode === 10
          ? 'pine-upi'
          : null
      : row.paymentMode === 1003
        ? 'paytm-card'
        : row.paymentMode === 1004
          ? 'paytm-qr'
          : null;
  if (!channel) throw legacyReview();
  return channel;
}
export const legacyReview = () =>
  new AppError(
    409,
    'LEGACY_PAYMENT_REVIEW_REQUIRED',
    'The original terminal payment needs review. Do not collect another payment or cancel the order.',
  );

export function legacyPaymentEvidence(
  records: readonly LegacyTerminalRecord[],
  attempts: readonly PaymentAttempt[],
) {
  if (records.length > 200 || attempts.length > 100) throw legacyReview();
  const matches = (record: LegacyTerminalRecord, attempt: PaymentAttempt) => {
    if (!attempt.channel.startsWith('pine-') && !attempt.channel.startsWith('paytm-')) return false;
    if (record.provider !== (attempt.channel.startsWith('pine-') ? 'pine' : 'paytm')) return false;
    if (
      attempt.legacySource?.legacyId === record.id &&
      attempt.legacySource.provider === record.provider
    )
      return true;
    return (
      record.transactionId === attempt.transactionId &&
      minorUnits(record.onlineAmount) === minorUnits(attempt.onlineAmount) &&
      minorUnits(record.cashAmount) === minorUnits(attempt.cashAmount) &&
      minorUnits(record.cashReceived) === minorUnits(attempt.cashReceived)
    );
  };
  // A historical completed event is money evidence even when mutable order flags were reverted.
  const completed = records.some(
    (row) =>
      row.platform === 'txn_completed' &&
      !attempts.some((a) => a.status === 'paid' && matches(row, a)),
  );
  const candidates = records.filter(
    (row) => row.platform === 'txn_created' && !attempts.some((a) => matches(row, a)),
  );
  const unique = new Set(candidates.map((row) => `${row.provider}:${row.transactionId}`));
  return {
    completed,
    candidates,
    ambiguous: unique.size !== candidates.length || candidates.length > 1,
  };
}
export function normalizedLegacyAmounts(row: LegacyTerminalRecord) {
  try {
    return {
      onlineAmount: amount(minorUnits(row.onlineAmount)),
      cashAmount: amount(minorUnits(row.cashAmount)),
      cashReceived: amount(minorUnits(row.cashReceived)),
    };
  } catch {
    throw legacyReview();
  }
}
