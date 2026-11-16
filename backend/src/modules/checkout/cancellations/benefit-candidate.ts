import { Temporal } from '@js-temporal/polyfill';
import { identifier } from '../../../domain/validation.js';
import { AppError } from '../../../domain/errors.js';

/** Approved original-expiry allocation policy; the writer separately checks every source trace. */
export interface CancellationEarningAllocation {
  mappingId: string;
  historyId: string;
  used: number;
  returned: number;
  expiry: string | null;
  expired: boolean;
  bonus: boolean;
}
export interface CancellationBenefitCandidate {
  allocations: {
    mappingId: string;
    historyId: string;
    returnedBefore: number;
    returnedAfter: number;
    amount: number;
    expired: boolean;
  }[];
  credits: { expiry: string | null; bonus: boolean; amount: number }[];
  expiredAmount: number;
}
const rejected = () =>
  new AppError(
    409,
    'CANCELLATION_EARNING_TRACE_INCOMPLETE',
    'Original benefit allocations require reconciliation.',
  );

/**
 * Approved original-expiry policy: exact source float arithmetic, no new validity
 * window; expired allocations are consumed/audited once without spendable credit.
 * Native locked execution and shared-writer/provenance contracts remain activation gates.
 */
export function planCancellationBenefitCandidate(
  requested: number,
  records: readonly CancellationEarningAllocation[],
  businessDate: string,
): CancellationBenefitCandidate {
  const day = Temporal.PlainDate.from(businessDate);
  if (!Number.isFinite(requested) || requested <= 0 || !records.length || records.length > 1000)
    throw rejected();
  const seen = new Set<string>();
  for (const row of records) {
    identifier.parse(row.mappingId);
    identifier.parse(row.historyId);
    if (
      seen.has(row.mappingId) ||
      !Number.isFinite(row.used) ||
      !Number.isFinite(row.returned) ||
      row.used < 0 ||
      row.returned < 0 ||
      row.returned > row.used
    )
      throw rejected();
    seen.add(row.mappingId);
    if (row.expiry !== null) Temporal.PlainDateTime.from(row.expiry.replace(' ', 'T'));
  }
  const sorted = [...records].sort((a, b) => (BigInt(a.mappingId) < BigInt(b.mappingId) ? -1 : 1)),
    allocations: CancellationBenefitCandidate['allocations'] = [],
    credits = new Map<string, CancellationBenefitCandidate['credits'][number]>();
  let remaining = requested,
    expiredAmount = 0;
  for (const row of sorted) {
    const available = row.used - row.returned;
    if (available <= 0 || remaining <= 0) continue;
    const full = remaining - available >= 0,
      amount = full ? available : remaining;
    remaining = full ? remaining - available : 0;
    const expired =
      row.expired ||
      (row.expiry !== null &&
        Temporal.PlainDate.compare(
          Temporal.PlainDateTime.from(row.expiry.replace(' ', 'T')).toPlainDate(),
          day,
        ) < 0);
    allocations.push({
      mappingId: row.mappingId,
      historyId: row.historyId,
      returnedBefore: row.returned,
      returnedAfter: row.returned + amount,
      amount,
      expired,
    });
    if (expired) {
      expiredAmount += amount;
      continue;
    }
    const key = JSON.stringify([row.expiry, row.bonus]),
      previous = credits.get(key);
    if (previous) previous.amount += amount;
    else credits.set(key, { expiry: row.expiry, bonus: row.bonus, amount });
  }
  if (remaining > 0) throw rejected();
  return { allocations, credits: [...credits.values()], expiredAmount };
}
