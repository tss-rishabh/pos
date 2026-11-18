import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../domain/errors.js';

function key(secret: string, purpose: string): Buffer {
  if (secret.length < 32)
    throw new AppError(
      503,
      'DISCOUNT_APPROVAL_UNAVAILABLE',
      'Manager discount approval is not configured.',
    );
  return createHmac('sha256', secret)
    .update('pos.discount-approval.v1.' + purpose)
    .digest();
}
/** core/tasks.py:251-253: six digits, each 1-9. */
export const approvalCode = () =>
  Array.from({ length: 6 }, () => String(randomInt(1, 10))).join('');
/**
 * Legacy stores the plaintext OTP as the JSON key of `{uid}_{store}_{counter}_{tab}`
 * (core/tasks.py:255). The rewrite stores this HMAC in its place (security decision).
 */
export const codeDigest = (secret: string, challengeId: string, managerId: string, code: string) =>
  createHmac('sha256', key(secret, 'digest'))
    .update(`${challengeId}:${managerId}:${code}`)
    .digest('hex');
export function matchesCode(
  secret: string,
  challengeId: string,
  managerId: string,
  code: string,
  digest: string,
): boolean {
  return (
    /^[a-f0-9]{64}$/.test(digest) &&
    timingSafeEqual(
      Buffer.from(codeDigest(secret, challengeId, managerId, code), 'hex'),
      Buffer.from(digest, 'hex'),
    )
  );
}
