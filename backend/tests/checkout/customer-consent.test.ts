import { describe, expect, it } from 'vitest';
import {
  assertCustomerConsentReady,
  customerConsentContract,
  signCustomerConsent,
  type CustomerConsent,
} from '../../src/modules/checkout/customer-consent.js';

const now = 1800000000000,
  key = 'fixture-customer-consent-key-0123456789';
const consent: CustomerConsent = {
  v: 1,
  contract: customerConsentContract,
  orderId: '9007199254740993',
  customerId: '77',
  operatorId: '44',
  storeId: '1',
  counterId: '3',
  contact: { revision: '18446744073709551615', digest: 'a'.repeat(64) },
  expiresAt: now + 600000,
};
describe('private customer consent wire contract', () => {
  it('matches the independently executed Go canonical JSON/HMAC golden with exact long IDs and revision', () => {
    const [encoded, signature] = signCustomerConsent(consent, key, now).split('.');
    expect(signature).toBe('ce17285983289c285b035ca976be0d821ef607da9666e385890b3186ab50c80d');
    expect(Buffer.from(encoded!, 'base64url').toString('utf8')).toBe(JSON.stringify(consent));
  });
  it.each([now, now - 1, now + 900001])(
    'rejects expired or extended consent lifetime %s',
    (expiresAt) => {
      expect(() => signCustomerConsent({ ...consent, expiresAt }, key, now)).toThrow();
    },
  );
  it('rejects unsigned/unverified contracts, unsafe native IDs and invalid digest/revision values', () => {
    expect(() => assertCustomerConsentReady({ checkoutProjectionKey: key })).toThrow();
    expect(() =>
      assertCustomerConsentReady({ checkoutProjectionKey: 'short', customerConsentContract }),
    ).toThrow();
    expect(() =>
      signCustomerConsent({ ...consent, orderId: '9223372036854775808' }, key, now),
    ).toThrow();
    expect(() =>
      signCustomerConsent(
        { ...consent, contact: { ...consent.contact, revision: '18446744073709551616' } },
        key,
        now,
      ),
    ).toThrow();
    expect(() =>
      signCustomerConsent(
        { ...consent, contact: { ...consent.contact, digest: 'not-a-digest' } },
        key,
        now,
      ),
    ).toThrow();
  });
});
