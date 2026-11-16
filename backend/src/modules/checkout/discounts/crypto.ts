import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
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
export const approvalCode = () =>
  Array.from({ length: 6 }, () => String(randomInt(1, 10))).join('');
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
export function encryptCode(secret: string, deliveryId: string, code: string): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(secret, 'encryption'), nonce);
  cipher.setAAD(Buffer.from(deliveryId));
  const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
export function decryptCode(secret: string, deliveryId: string, sealed: string): string {
  const encoded = Buffer.from(sealed, 'base64url');
  if (encoded.length !== 34) throw new Error('Invalid approval delivery');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(secret, 'encryption'),
    encoded.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(deliveryId));
  decipher.setAuthTag(encoded.subarray(12, 28));
  const code = Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString(
    'utf8',
  );
  if (!/^[1-9]{6}$/.test(code)) throw new Error('Invalid approval delivery');
  return code;
}
