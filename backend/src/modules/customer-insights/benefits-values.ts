import { Temporal } from '@js-temporal/polyfill';
import { Decimal } from 'decimal.js';
import type { CustomerBenefits } from './benefits-contracts.js';

/** Source Helpers.round_down uses Decimal(str(value)), after the separate >=1 guard. */
export function customerWalletDisplay(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Customer balance is unavailable.');
  return value < 1 ? '0.00' : new Decimal(String(value)).toFixed(2, Decimal.ROUND_DOWN);
}

/** The three source strptime profiles accept non-padded components and microseconds. */
export function membershipExpiry(value: string | null): string | null {
  if (!value) return null;
  const match =
    /^(\d{4})-(\d{1,2})-(\d{1,2})([ T])(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match || (match[4] === ' ' && match[8])) return null;
  try {
    const microseconds = (match[8] ?? '').padEnd(6, '0');
    const result = Temporal.PlainDateTime.from(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[5]),
        minute: Number(match[6]),
        second: Number(match[7]),
        millisecond: Number(microseconds.slice(0, 3)),
        microsecond: Number(microseconds.slice(3)),
      },
      { overflow: 'reject' },
    );
    return result.year >= 1 ? result.toString() : null;
  } catch {
    return null;
  }
}
export function customerMembership(
  row: { value: string | null; active: number | null } | undefined,
  now: Temporal.PlainDateTime,
): CustomerBenefits['membership'] {
  if (!row) return { active: false, expiry: null, message: '' };
  if (row.active === null || !Number.isInteger(row.active))
    throw new Error('Customer membership is unavailable.');
  const active = row.active !== 0,
    expiry = membershipExpiry(row.value);
  return {
    active,
    expiry,
    message:
      !active && expiry && Temporal.PlainDateTime.compare(expiry, now) > 0
        ? "User's Membership is deactivated."
        : '',
  };
}
