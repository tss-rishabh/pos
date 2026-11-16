import { AppError } from '../../domain/errors.js';
import { voucherAmount } from './contracts.js';

export function voucherMinorUnits(input: string): bigint {
  const value = voucherAmount.parse(input),
    [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function voucherAmountString(minor: bigint): string {
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw voucherIntegrity();
  return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
}
export function storedVoucherMinorUnits(value: number | null): bigint {
  if (
    value === null ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(Math.round(value * 100)) ||
    Math.abs(value * 100 - Math.round(value * 100)) > 0.000001
  )
    throw voucherIntegrity();
  return BigInt(Math.round(value * 100));
}
export function voucherIntegrity() {
  return new AppError(
    409,
    'VOUCHER_VALUE_REPAIR_REQUIRED',
    'The voucher or wallet value requires review.',
  );
}
export function planVoucherConversion(
  value: number | null,
  initial: number | null,
  wallet: number,
  cashback: number,
) {
  const amount = storedVoucherMinorUnits(value),
    original = storedVoucherMinorUnits(initial),
    before = storedVoucherMinorUnits(wallet);
  if (amount <= 0n || amount > original || !Number.isFinite(cashback) || cashback < 0)
    throw voucherIntegrity();
  const after = before + amount;
  const numeric = Number(voucherAmountString(after));
  if (!Number.isFinite(numeric) || Math.abs(Math.fround(numeric) - numeric) >= 0.005)
    throw new AppError(
      409,
      'WALLET_FLOAT_PRECISION_UNSAFE',
      'The legacy wallet cannot safely store this amount.',
    );
  return { amount, before, after, numeric };
}
/** Exact source zero-date conventions, scoped to the gift-card date branch only. */
export function giftCardDatesValid(start: string | null, end: string | null, now: string) {
  const zero = '0000-00-00 00:00:00';
  if (!start || !end) return false;
  return (start === zero || start <= now) && (end === zero || end >= now);
}
