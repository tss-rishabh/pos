import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { registrationDigest } from '../checkout/customers/crypto.js';
import { contactEnvelope, contactOtpPayload } from './contracts.js';
import type { CustomerContactStage } from './schema.js';

export const contactCode = () => randomInt(0, 1000000).toString().padStart(6, '0');
export function contactDigest(secret: string, purpose: string, value: string) {
  return createHmac('sha256', secret)
    .update('customer-contacts:' + purpose + ':')
    .update(value)
    .digest('hex');
}
export function customerContactReservationKey(
  secret: string,
  kind: 'telephone' | 'email',
  value: string,
) {
  const category = kind === 'telephone' ? 'phone' : 'email';
  return (
    category +
    ':' +
    registrationDigest(secret, category, kind === 'email' ? value.toLowerCase() : value)
  );
}
export function contactCodeDigest(
  secret: string,
  challengeId: string,
  stage: CustomerContactStage,
  value: string,
) {
  return contactDigest(secret, 'otp', JSON.stringify([challengeId, stage, value]));
}
export function matchesContactCode(
  expected: string,
  secret: string,
  id: string,
  stage: CustomerContactStage,
  code: string,
) {
  const actual = Buffer.from(contactCodeDigest(secret, id, stage, code), 'hex'),
    stored = Buffer.from(expected, 'hex');
  return stored.length === actual.length && timingSafeEqual(stored, actual);
}
export function sealContact(secret: string, id: string, value: unknown) {
  z.uuid().parse(id);
  const plaintext = Buffer.from(JSON.stringify(value));
  if (plaintext.length > 256000) throw new Error('Contact payload exceeds its bounded size.');
  const nonce = randomBytes(12),
    cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(contactDigest(secret, 'encryption-key', 'v1'), 'hex'),
      nonce,
    );
  cipher.setAAD(Buffer.from('customer-contacts:v1:' + id));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
export function openContact<T>(secret: string, id: string, value: string, schema: z.ZodType<T>): T {
  z.uuid().parse(id);
  if (value.length > 342000 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Contact payload is invalid.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < 29 || bytes.length > 256028) throw new Error('Contact payload is invalid.');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(contactDigest(secret, 'encryption-key', 'v1'), 'hex'),
    bytes.subarray(0, 12),
  );
  cipher.setAAD(Buffer.from('customer-contacts:v1:' + id));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return schema.parse(
    JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
    ) as unknown,
  );
}
export const openContactEnvelope = (secret: string, id: string, value: string) =>
  openContact(secret, id, value, contactEnvelope);
export const openContactOtp = (secret: string, id: string, value: string) =>
  openContact(secret, id, value, contactOtpPayload);
