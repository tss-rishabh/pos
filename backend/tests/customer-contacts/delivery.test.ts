import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCustomerContactDelivery } from '../../src/modules/customer-contacts/delivery.js';
import { readCustomerContactOptions } from '../../src/modules/customer-contacts/options.js';
import { contactOtpPayload } from '../../src/modules/customer-contacts/contracts.js';

const options = readCustomerContactOptions({
    CUSTOMER_CONTACTS_ENABLED: 'true',
    CUSTOMER_CONTACTS_CONTRACT: 'pos-customer-contact-v1',
    CUSTOMER_CONTACTS_SECRET: 'synthetic-contact-payload-key-'.repeat(2),
    CUSTOMER_REGISTRATION_SECRET: 'synthetic-registration-fence-key-'.repeat(2),
    CUSTOMER_CONTACT_SMS_TEMPLATE:
      '{{code}} confirms the customer contact addition you requested. Do not share this code.',
  }),
  environment = {
    GUPSHUP_SMS_USER_ID: 'synthetic-user',
    GUPSHUP_SMS_PASSWORD: 'synthetic-password',
    NETCORE_EMAIL_URL: 'https://email.fixture.test/send',
    NETCORE_API_KEY: 'synthetic-netcore-key',
  };
const otp = (channel: 'sms' | 'email') =>
  contactOtpPayload.parse({
    purpose: 'customer-contact-otp-v1',
    challengeId: randomUUID(),
    stage: 'new',
    channel,
    destination: channel === 'sms' ? '9876543210' : 'private.fixture@example.test',
    code: '123456',
  });
describe('purpose-only private contact transport', () => {
  it('sends the approved SMS purpose in a POST body and requires the gateway success acknowledgement', async () => {
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    const sender = createCustomerContactDelivery(
      { DEMO_MODE: false },
      options,
      environment,
      async (input, init) => {
        calls.push({ url: new URL(String(input)), init });
        return new Response('success | synthetic-message-id');
      },
    )!;
    expect(await sender.sendOtp(randomUUID(), otp('sms'), new AbortController().signal)).toBe(
      'accepted',
    );
    const call = calls[0]!,
      body = new URLSearchParams(String(call.init?.body));
    expect(call.url.search).toBe('');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.redirect).toBe('error');
    expect(body.get('send_to')).toBe('9876543210');
    expect(body.get('msg')).toContain('customer contact addition');
    expect(body.get('msg')).not.toContain('log in');
  });
  it('keeps email/code/API key out of URLs and refuses an unconfirmed200 response', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const sender = createCustomerContactDelivery(
      { DEMO_MODE: false },
      options,
      environment,
      async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({ status: 'error' });
      },
    )!;
    expect(await sender.sendOtp(randomUUID(), otp('email'), new AbortController().signal)).toBe(
      'uncertain',
    );
    expect(calls[0]?.url).toBe('https://email.fixture.test/send');
    expect(String(calls[0]?.init?.body)).toContain('private.fixture@example.test');
    expect(calls[0]?.init?.redirect).toBe('error');
  });
  it('fails closed on invalid private inputs without dispatch', async () => {
    let sent = 0;
    const sender = createCustomerContactDelivery(
      { DEMO_MODE: false },
      options,
      environment,
      async () => {
        sent++;
        throw new Error('Synthetic network refusal');
      },
    )!;
    expect(
      await sender.sendOtp(
        randomUUID(),
        { ...otp('sms'), destination: 'not-a-number' },
        new AbortController().signal,
      ),
    ).toBe('rejected');
    expect(sent).toBe(0);
  });
});
