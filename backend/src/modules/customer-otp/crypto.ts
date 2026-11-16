import { createHmac, timingSafeEqual } from 'node:crypto';
import { contactCode, openContact, sealContact } from '../customer-contacts/crypto.js';
import { customerOtpPayloadSchema, type CustomerOtpPayload } from './contracts.js';

export const customerOtpCode = contactCode;
export function customerOtpDigest(secret: string, purpose: string, value: unknown) {
  return createHmac('sha256', secret)
    .update('customer-otp:v1:' + purpose + ':')
    .update(JSON.stringify(value))
    .digest('hex');
}
export function sameCustomerOtpCode(expected: string, secret: string, id: string, code: string) {
  const actual = Buffer.from(customerOtpDigest(secret, 'code', [id, code]), 'hex');
  const stored = Buffer.from(expected, 'hex');
  return stored.length === actual.length && timingSafeEqual(stored, actual);
}
// Reuse the bounded owner-AAD cipher with a separately derived purpose key.
export function sealCustomerOtp(secret: string, id: string, payload: CustomerOtpPayload) {
  return sealContact(
    customerOtpDigest(secret, 'delivery-key', 'v1'),
    id,
    customerOtpPayloadSchema.parse(payload),
  );
}
export function openCustomerOtp(secret: string, id: string, payload: string) {
  return openContact(
    customerOtpDigest(secret, 'delivery-key', 'v1'),
    id,
    payload,
    customerOtpPayloadSchema,
  );
}
