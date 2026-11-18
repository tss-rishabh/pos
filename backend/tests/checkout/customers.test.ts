import { describe, expect, it } from 'vitest';
import { phoneOtpDelivery } from '../../src/auth/delivery.js';
import {
  registrationPayload,
  validateRegistrationDetails,
} from '../../src/modules/checkout/customers/contracts.js';
import {
  openRegistration,
  registrationCodeDigest,
  registrationCodeMatches,
  sealRegistration,
} from '../../src/modules/checkout/customers/crypto.js';
import {
  assertRegistrationReady,
  registrationEnvironment,
} from '../../src/modules/checkout/customers/service.js';
import { goldenStdout } from '../golden/load.js';

const oracle = (operation: string): unknown =>
  JSON.parse(goldenStdout('checkout', 'customers', JSON.stringify({ operation }))) as unknown;
const details = {
  name: 'Fixture Customer',
  telephone: '9000000001',
  email: '',
  birthdate: '1990-01-02',
  customerType: 'B2C' as const,
  gstin: '',
};
describe('customer source contracts and secret handling', () => {
  it('preserves registration fields, temporary email convention and source clear/detach behavior', () => {
    expect([
      { path: 'store-register', payload: registrationPayload(details, '1') },
      {
        path: 'store-register',
        payload: registrationPayload(
          {
            ...details,
            customerType: 'B2B',
            gstin: '29ABCDE1234F1Z5',
            email: 'fixture@example.com',
          },
          '1',
        ),
      },
    ]).toEqual(oracle('customer_registration_payloads'));
    expect(oracle('clear_customer_state')).toEqual({
      deleted: ['777_2', 2, '1_2', '1_2_10'],
      status: 'success',
      count: 0,
    });
  });
  it('uses source SMS/WhatsApp fields through the shared POST transport without contact or secrets in URLs', async () => {
    const captured: { url: string; payload: Record<string, string> }[] = [],
      delivery = phoneOtpDelivery(
        {
          GUPSHUP_SMS_USER_ID: 'fixture-sms-user',
          GUPSHUP_SMS_PASSWORD: 'fixture-sms-secret',
          WHATSAPP_GUPSHUP_API_URL: 'https://whatsapp.example.test/',
          GUPSHUP_WHATSAPP_USER_ID: 'fixture-wa-user',
          GUPSHUP_WHATSAPP_PASSWORD: 'fixture-wa-secret',
        },
        async (url, init) => {
          expect(init?.method).toBe('POST');
          expect(init?.redirect).toBe('error');
          captured.push({
            url: String(url),
            payload: Object.fromEntries(new URLSearchParams(String(init?.body))),
          });
          return new Response('success | fixture');
        },
      );
    await delivery.send('9000000001', '111111', 'sms');
    await delivery.send('9000000001', '111111', 'whatsapp');
    const source = oracle('registration_otp_payloads');
    expect(
      captured.map((call) => ({
        ...call,
        payload: {
          ...call.payload,
          v: String(call.payload.v),
          send_to: String(call.payload.send_to),
        },
      })),
    ).toEqual(
      (source as typeof captured).map((call) => ({
        ...call,
        payload: {
          ...call.payload,
          v: String(call.payload.v),
          send_to: String(call.payload.send_to),
        },
      })),
    );
    expect(
      captured.every(
        (call) =>
          !call.url.includes('9000000001') &&
          !call.url.includes('secret') &&
          !call.url.includes('111111'),
      ),
    ).toBe(true);
  });
  it('validates all supplied fields and refuses self-verification and unavailable OTP configuration', () => {
    expect(validateRegistrationDetails(details, 'Asia/Kolkata')).toEqual(details);
    for (const change of [
      { self_verify: true },
      { telephone: '1234567890' },
      { birthdate: '2999-01-01' },
      { birthdate: '0000-01-01' },
      { customerType: 'B2B', gstin: '' },
      { gstin: '29ABCDE1234F1Z5' },
      { name: '<script>' },
    ])
      expect(() =>
        validateRegistrationDetails({ ...details, ...change }, 'Asia/Kolkata'),
      ).toThrow();
    expect(() => assertRegistrationReady(registrationEnvironment({}))).toThrowError(
      expect.objectContaining({ code: 'CUSTOMER_REGISTRATION_UNAVAILABLE' }),
    );
    expect(() => registrationEnvironment({ LOGIN_OTP_EXPIRY: '0' })).toThrow();
  });
  it('authenticates encrypted identity details and binds code hashes to the exact registration and checkout', () => {
    const secret = 'fixture-registration-secret-'.repeat(3),
      id = crypto.randomUUID(),
      checkoutId = crypto.randomUUID(),
      sealed = sealRegistration(secret, id, { details, code: '111111' }),
      digest = registrationCodeDigest(secret, id, checkoutId, '111111');
    expect(openRegistration(secret, id, sealed)).toEqual({ details, code: '111111' });
    expect(sealed).not.toContain(details.telephone);
    expect(sealed).not.toContain('@');
    expect(() => openRegistration(secret, crypto.randomUUID(), sealed)).toThrow();
    expect(() => openRegistration('wrong-secret'.repeat(5), id, sealed)).toThrow();
    expect(registrationCodeMatches(secret, id, checkoutId, '111111', digest)).toBe(true);
    expect(registrationCodeMatches(secret, id, crypto.randomUUID(), '111111', digest)).toBe(false);
    expect(registrationCodeMatches(secret, id, checkoutId, '000000', digest)).toBe(false);
  });
});
