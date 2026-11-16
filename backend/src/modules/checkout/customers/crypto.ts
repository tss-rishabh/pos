import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

const key = (secret: string, purpose: string) =>
  createHmac('sha256', secret).update(`pos.customer-registration.v1.${purpose}`).digest();
export const registrationCode = () =>
  Array.from({ length: 6 }, () => String(randomInt(1, 10))).join('');
export const registrationDigest = (secret: string, purpose: string, value: string) =>
  createHmac('sha256', key(secret, purpose)).update(value).digest('hex');
export const registrationCodeDigest = (
  secret: string,
  id: string,
  checkoutId: string,
  code: string,
) => registrationDigest(secret, 'code', `${id}:${checkoutId}:${code}`);
export function registrationCodeMatches(
  secret: string,
  id: string,
  checkoutId: string,
  code: string,
  digest: string,
) {
  return (
    /^[a-f0-9]{64}$/.test(digest) &&
    timingSafeEqual(
      Buffer.from(registrationCodeDigest(secret, id, checkoutId, code), 'hex'),
      Buffer.from(digest, 'hex'),
    )
  );
}
export function sealRegistration(secret: string, id: string, input: unknown): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(secret, 'encryption'), nonce);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(input), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function openRegistration(secret: string, id: string, sealed: string): unknown {
  const encoded = Buffer.from(sealed, 'base64url');
  if (encoded.length < 29 || encoded.length > 6000)
    throw new Error('Invalid registration envelope');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    key(secret, 'encryption'),
    encoded.subarray(0, 12),
  );
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(encoded.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(encoded.subarray(28)), cipher.final()]).toString('utf8'),
  ) as unknown;
}
