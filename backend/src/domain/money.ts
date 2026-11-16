import { Decimal } from 'decimal.js';
import { AppError } from './errors.js';

export function minorUnits(value: string): bigint {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new AppError(
      400,
      'INVALID_AMOUNT',
      'Use a non-negative amount with at most two decimal places.',
    );
  return BigInt(new Decimal(value).mul(100).toFixed(0));
}
export function amount(minor: bigint): string {
  return new Decimal(minor.toString()).div(100).toFixed(2);
}
/** Python-compatible tie-to-even policy; runtime fixture tests cover legacy float differences. */
export function roundMoney(value: Decimal.Value): number {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toNumber();
}
export function draftTotal(items: { unitPrice: string; quantity: number }[]): string {
  return amount(
    items.reduce((total, line) => {
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 999)
        throw new AppError(400, 'INVALID_QUANTITY', 'Quantity must be between 1 and 999.');
      return total + minorUnits(line.unitPrice) * BigInt(line.quantity);
    }, 0n),
  );
}
