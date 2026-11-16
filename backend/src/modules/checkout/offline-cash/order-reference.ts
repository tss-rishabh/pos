import { randomInt } from 'node:crypto';
import { AppError } from '../../../domain/errors.js';

/** Literal MOBILE branch of pinned libs/OrderRef.py; integer arithmetic preserves BIGINT IDs. */
export function offlineCashOrderReference(
  orderId: string,
  random: (min: number, max: number) => number = randomInt,
): string {
  if (!/^[1-9]\d{2,18}$/.test(orderId))
    throw new AppError(
      503,
      'OFFLINE_CASH_ORDER_REFERENCE_UNAVAILABLE',
      'The allocated order reference cannot be represented safely.',
    );
  const prefix = random(11, 100),
    last = random(2, 10),
    tail = Number(orderId.slice(-2));
  const randomLast = tail < last ? tail : last,
    randomPart = String(prefix) + String(randomLast);
  return `2001-${BigInt(orderId.slice(0, -2)) - BigInt(randomPart)}-${String(tail - randomLast).padStart(2, '0')}${randomPart}`;
}
