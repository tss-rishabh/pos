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
export function voucherIntegrity() {
  return new AppError(
    409,
    'VOUCHER_VALUE_REPAIR_REQUIRED',
    'The voucher or wallet value requires review.',
  );
}
