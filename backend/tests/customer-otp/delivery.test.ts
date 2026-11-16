import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCustomerOtpDelivery } from '../../src/modules/customer-otp/delivery.js';
import { readCustomerOtpOptions } from '../../src/modules/customer-otp/options.js';
import { customerOtpPayloadSchema } from '../../src/modules/customer-otp/contracts.js';

const env = {
  GUPSHUP_SMS_USER_ID: 'synthetic-sms-user',
  GUPSHUP_SMS_PASSWORD: 'synthetic-sms-secret',
  WHATSAPP_GUPSHUP_API_URL: 'https://whatsapp.fixture.test/send',
  GUPSHUP_WHATSAPP_USER_ID: 'synthetic-wa-user',
  GUPSHUP_WHATSAPP_PASSWORD: 'synthetic-wa-secret',
  NETCORE_EMAIL_URL: 'https://email.fixture.test/send',
  NETCORE_API_KEY: 'synthetic-email-secret',
};
const options = readCustomerOtpOptions({
  CUSTOMER_OTP_ENABLED: 'true',
  CUSTOMER_OTP_TEMPLATE_CONTRACT: 'pos-customer-otp-purpose-v1',
  CUSTOMER_OTP_CHECKOUT_SMS_TEMPLATE: '{{code}} verifies your requested in-store account benefits.',
  CUSTOMER_OTP_RETURN_SMS_TEMPLATE: '{{code}} verifies your requested in-store return.',
  CUSTOMER_OTP_CHECKOUT_EMAIL_TEMPLATE:
    '{{code}} verifies your requested in-store account benefits.',
  CUSTOMER_OTP_RETURN_EMAIL_TEMPLATE: '{{code}} verifies your requested in-store return.',
  CUSTOMER_OTP_CHECKOUT_WHATSAPP_TEMPLATE:
    '{{code}} verifies your requested in-store account benefits.',
  CUSTOMER_OTP_RETURN_WHATSAPP_TEMPLATE: '{{code}} verifies your requested in-store return.',
});
const input = (
  channel: 'sms' | 'email' | 'whatsapp',
  purpose: 'checkout-benefits' | 'order-return' = 'checkout-benefits',
) =>
  customerOtpPayloadSchema.parse({
    contract: 'pos-customer-otp-delivery-v1',
    channel,
    purpose,
    destination: channel === 'email' ? 'otp.fixture@example.test' : '9876543210',
    code: '123456',
  });
describe('safe purpose-bound customer OTP transport', () => {
  it.each(['sms', 'whatsapp'] as const)(
    'sends %s credentials/contact/code only in a bounded POST body',
    async (channel) => {
      let received: { url: URL; init: RequestInit | undefined } | undefined;
      const sender = createCustomerOtpDelivery(
        { DEMO_MODE: false },
        options,
        env,
        async (url, init) => {
          received = { url: new URL(String(url)), init };
          return new Response('success | synthetic-message');
        },
      )!;
      expect(
        await sender.send(
          randomUUID(),
          input(channel, 'order-return'),
          new AbortController().signal,
        ),
      ).toBe('accepted');
      expect(received?.url.search).toBe('');
      expect(received?.url.username).toBe('');
      expect(received?.init?.method).toBe('POST');
      expect(received?.init?.redirect).toBe('error');
      const body = new URLSearchParams(String(received?.init?.body));
      expect(body.get('send_to')).toBe('9876543210');
      expect(body.get('msg')).toContain('in-store return');
      expect(received?.init?.signal).toBeInstanceOf(AbortSignal);
    },
  );
  it('requires an actual success acknowledgement and never treats an ambiguous200 as delivery', async () => {
    const sender = createCustomerOtpDelivery(
      { DEMO_MODE: false },
      options,
      env,
      async () => new Response('provider returned unrecognized text'),
    )!;
    expect(await sender.send(randomUUID(), input('sms'), new AbortController().signal)).toBe(
      'uncertain',
    );
    expect(await sender.send(randomUUID(), input('email'), new AbortController().signal)).toBe(
      'uncertain',
    );
  });
  it('requires approved purpose templates and rejects unsafe email/provider URLs before dispatch', async () => {
    expect(
      readCustomerOtpOptions({ CUSTOMER_OTP_CONTRACT: '', CUSTOMER_OTP_TEMPLATE_CONTRACT: '' })
        .CUSTOMER_OTP_ENABLED,
    ).toBe(false);
    let sends = 0;
    const sender = createCustomerOtpDelivery(
      { DEMO_MODE: false },
      readCustomerOtpOptions({ CUSTOMER_OTP_ENABLED: 'true' }),
      env,
      async () => {
        sends++;
        return Response.json({ status: 'success' });
      },
    )!;
    expect(() => sender.assertReady('order-return', 'sms')).toThrow('configured secure delivery');
    expect(await sender.send(randomUUID(), input('sms'), new AbortController().signal)).toBe(
      'uncertain',
    );
    const unsafe = createCustomerOtpDelivery(
      { DEMO_MODE: false },
      options,
      {
        ...env,
        NETCORE_EMAIL_URL:
          'https://secret@invalid.fixture.test/send?email=otp.fixture@example.test',
      },
      async () => {
        sends++;
        return Response.json({ status: 'success' });
      },
    )!;
    expect(() => unsafe.assertReady('checkout-benefits', 'email')).toThrow('HTTPS endpoint');
    expect(sends).toBe(0);
    expect(() =>
      readCustomerOtpOptions({ CUSTOMER_OTP_CHECKOUT_SMS_TEMPLATE: '{{code}}{{code}}' }),
    ).toThrow();
  });
  it('keeps email purpose content and API credentials in private POST data', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const sender = createCustomerOtpDelivery(
      { DEMO_MODE: false },
      options,
      env,
      async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({ status: 'success' });
      },
    )!;
    expect(await sender.send(randomUUID(), input('email'), new AbortController().signal)).toBe(
      'accepted',
    );
    expect(requests[0]?.url).toBe('https://email.fixture.test/send');
    expect(String(requests[0]?.init?.body)).toContain('in-store account benefits');
    expect(requests[0]?.init?.redirect).toBe('error');
  });
});
