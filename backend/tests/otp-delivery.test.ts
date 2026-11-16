import { it, expect } from 'vitest';
import { otpDelivery, phoneOtpDelivery } from '../src/auth/delivery.js';
import type { PasswordIdentity } from '../src/auth/identity.js';

const account: PasswordIdentity = {
  user: {
    id: '1',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 5,
    userType: 1,
    storeIds: ['1'],
  },
  authVersion: 'a'.repeat(64),
  useTotp: false,
  totpSecret: null,
  phone: '1000000000',
  contactEmail: 'fixture@example.test',
  firstName: '<img src=x onerror=canary()>',
  otpMethod: 'sms',
};
it('keeps SMS credentials and OTP out of URLs and requires an explicit provider acknowledgement', async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  let reply = 'success | 1000000000 | fixture-id';
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(reply);
  };
  const delivery = otpDelivery(
    { GUPSHUP_SMS_USER_ID: 'fixture-user', GUPSHUP_SMS_PASSWORD: 'fixture-provider-secret' },
    fetcher,
  );
  await delivery.send(account, '908172', false);
  expect(new URL(requests[0]!.url).search).toBe('');
  expect(requests[0]!.init?.method).toBe('POST');
  const body = requests[0]!.init?.body;
  expect(body).toBeInstanceOf(URLSearchParams);
  expect(String(body)).toContain('fixture-provider-secret');
  reply = 'unsuccessful request';
  await expect(delivery.send(account, '908172', false)).rejects.toMatchObject({
    code: 'OTP_DELIVERY_UNCERTAIN',
  });
  reply = 'x'.repeat(64001);
  await expect(delivery.send(account, '908172', false)).rejects.toMatchObject({
    code: 'OTP_DELIVERY_UNCERTAIN',
  });
});
it('escapes dynamic email HTML and rejects an HTTP-200 provider failure payload', async () => {
  let responseStatus = 'success',
    payload = '';
  const delivery = otpDelivery(
    { NETCORE_EMAIL_URL: 'https://fixture.invalid/mail/send', NETCORE_API_KEY: 'fixture-api-key' },
    async (_input, init) => {
      payload = String(init?.body);
      return Response.json({ status: responseStatus });
    },
  );
  await delivery.send({ ...account, otpMethod: 'email' }, '908172', false);
  expect(payload).toContain('&lt;img');
  expect(payload).not.toContain('<img');
  responseStatus = 'error';
  await expect(
    delivery.send({ ...account, otpMethod: 'email' }, '908172', false),
  ).rejects.toMatchObject({ code: 'OTP_DELIVERY_UNCERTAIN' });
});
it('shares source phone templates without requiring a fabricated operator account', async () => {
  const requests: { url: string; body: URLSearchParams }[] = [],
    sender = phoneOtpDelivery(
      {
        GUPSHUP_SMS_USER_ID: 'fixture-sms',
        GUPSHUP_SMS_PASSWORD: 'fixture-sms-secret',
        WHATSAPP_GUPSHUP_API_URL: 'https://fixture.example.test/whatsapp',
        GUPSHUP_WHATSAPP_USER_ID: 'fixture-wa',
        GUPSHUP_WHATSAPP_PASSWORD: 'fixture-wa-secret',
      },
      async (url, init) => {
        requests.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
        return Response.json({ response: { status: 'success' } });
      },
    );
  sender.assertReady('sms');
  sender.assertReady('whatsapp');
  await sender.send('1000000000', '908172', 'sms');
  await sender.send('1000000000', '908172', 'whatsapp');
  expect(requests.map((call) => new URL(call.url).search)).toEqual(['', '']);
  expect(requests[0]!.body.get('msg')).toBe('908172 is your OTP to log in to The Souled Store.');
  expect(requests[1]!.body.get('msg')).toBe(
    '908172 is your verification code. For your security, do not share this code.',
  );
  expect(requests[1]!.body.get('footer')).toBe('This code expires in 10 minute.');
  await expect(sender.send('1000000000', 'not-an-otp', 'sms')).rejects.toMatchObject({
    code: 'OTP_DELIVERY_INPUT_INVALID',
  });
  expect(requests).toHaveLength(2);
  const invalid = phoneOtpDelivery({
    WHATSAPP_GUPSHUP_API_URL: 'https://fixture.example.test/#private',
    GUPSHUP_WHATSAPP_USER_ID: 'fixture',
    GUPSHUP_WHATSAPP_PASSWORD: 'fixture',
  });
  expect(() => invalid.assertReady('whatsapp')).toThrow();
});
