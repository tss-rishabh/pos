import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  customerOtpDigest,
  openCustomerOtp,
  sameCustomerOtpCode,
  sealCustomerOtp,
} from '../../src/modules/customer-otp/crypto.js';
import { customerOtpPayloadSchema } from '../../src/modules/customer-otp/contracts.js';

const secret = 'synthetic-private-purpose-customer-otp-key-'.repeat(2);
describe('purpose/owner-bound customer OTP secrets', () => {
  it('never accepts another challenge hash even when the numeric code is identical', () => {
    const left = randomUUID(),
      right = randomUUID();
    const hash = customerOtpDigest(secret, 'code', [left, '123456']);
    expect(sameCustomerOtpCode(hash, secret, left, '123456')).toBe(true);
    expect(sameCustomerOtpCode(hash, secret, right, '123456')).toBe(false);
    expect(sameCustomerOtpCode(hash, secret, left, '654321')).toBe(false);
  });
  it('rejects copied/tampered queued delivery secrets and requires a typed purpose', () => {
    const id = randomUUID(),
      payload = customerOtpPayloadSchema.parse({
        contract: 'pos-customer-otp-delivery-v1',
        purpose: 'order-return',
        channel: 'sms',
        destination: '9876543210',
        code: '123456',
      });
    const encrypted = sealCustomerOtp(secret, id, payload);
    expect(openCustomerOtp(secret, id, encrypted)).toEqual(payload);
    expect(() => openCustomerOtp(secret, randomUUID(), encrypted)).toThrow();
    expect(() => openCustomerOtp(secret + 'wrong', id, encrypted)).toThrow();
  });
});
