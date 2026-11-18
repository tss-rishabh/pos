import { it, expect } from 'vitest';
import {
  liveLoginOtpTransport,
  loginDeliveryOptions,
  loginOtpDelivery,
  phoneOtpDelivery,
} from '../src/auth/delivery.js';
import type { AuthEvent } from '../src/auth/events.js';

const recipient = {
  userId: '1',
  phone: '1000000000',
  contactEmail: 'fixture@example.test',
  firstName: '<img src=x onerror=canary()>',
  otpMethod: 1,
};
const env = {
  GUPSHUP_SMS_USER_ID: 'fixture-user',
  GUPSHUP_SMS_PASSWORD: 'fixture-provider-secret',
  GUPSHUP_WHATSAPP_USER_ID: 'fixture-wa',
  GUPSHUP_WHATSAPP_PASSWORD: 'fixture-wa-secret',
  NETCORE_EMAIL_URL: 'https://fixture.invalid/mail/send',
  NETCORE_API_KEY: 'fixture-api-key',
  LOGIN_SECURITY_SLACK_WEBHOOK: 'https://hooks.slack.com/services/fixture',
  LOGIN_OTP_DELIVERY: 'live',
};
it('keeps provider credentials and OTP out of URLs (S11) and swallows provider failures as legacy does', async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [],
    events: AuthEvent[] = [];
  let fail = false;
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (fail) throw new Error('network');
    return new Response('success | 1000000000 | fixture-id');
  };
  const delivery = loginOtpDelivery(
    liveLoginOtpTransport(loginDeliveryOptions(env, 'test'), fetcher),
    (event) => events.push(event),
  );
  await delivery.deliver(recipient, '908172', true);
  await delivery.drain();
  expect(requests.map((call) => new URL(call.url).search)).toEqual(['', '']);
  expect(requests.map((call) => call.init?.method)).toEqual(['POST', 'POST']);
  expect(new URL(requests[0]!.url).hostname).toBe('enterprise.smsgupshup.com');
  expect(new URL(requests[1]!.url).hostname).toBe('mediaapi.smsgupshup.com');
  const sms = requests[0]!.init?.body;
  expect(sms).toBeInstanceOf(URLSearchParams);
  expect(String(sms)).toContain('fixture-provider-secret');
  fail = true;
  await expect(delivery.deliver(recipient, '908172', false)).resolves.toBeUndefined();
  expect(events.map((event) => event.eventId)).toEqual(['identity.login-otp.sms-failed']);
  expect(JSON.stringify(events)).not.toContain('908172');
});
it('escapes the email name (S12), refuses non-Slack webhooks and is never sandboxed in production', async () => {
  let payload = '';
  const transport = liveLoginOtpTransport(
    loginDeliveryOptions(env, 'test'),
    async (_input, init) => {
      payload = String(init?.body);
      return Response.json({ status: 'success' });
    },
  );
  await loginOtpDelivery(transport, () => {}).deliver(
    { ...recipient, otpMethod: 2 },
    '908172',
    false,
  );
  expect(payload).toContain('&lt;img');
  expect(payload).not.toContain('<img');
  expect(JSON.parse(payload)).toMatchObject({ subject: 'POS login OTP' });
  const notSlack = liveLoginOtpTransport(
    loginDeliveryOptions(
      { ...env, LOGIN_SECURITY_SLACK_WEBHOOK: 'https://evil.example/hook' },
      'test',
    ),
    async () => new Response('ok'),
  );
  await expect(notSlack.slack('login-security', 'x')).rejects.toThrow();
  expect(loginDeliveryOptions({}, 'test').mode).toBe('sandbox');
  expect(loginDeliveryOptions({}, 'production').mode).toBe('live');
  expect(() => loginDeliveryOptions({ LOGIN_OTP_DELIVERY: 'sandbox' }, 'production')).toThrow();
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
