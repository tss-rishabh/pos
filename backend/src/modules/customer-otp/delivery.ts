import { z } from 'zod';
import type { Config } from '../../config.js';
import { createOtpTransport } from '../../auth/delivery.js';
import { boundedJson } from '../../domain/http-json.js';
import {
  customerOtpPayloadSchema,
  type CustomerOtpDelivery,
  type CustomerOtpPurpose,
} from './contracts.js';
import type { CustomerOtpOptions } from './options.js';
import { customerOtpUnavailable } from './authority.js';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
export function createCustomerOtpDelivery(
  config: Pick<Config, 'DEMO_MODE'>,
  options: CustomerOtpOptions,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): CustomerOtpDelivery | undefined {
  if (config.DEMO_MODE || !options.CUSTOMER_OTP_ENABLED) return undefined;
  const transport = createOtpTransport(env, fetcher),
    providers = transport.options;
  function template(purpose: CustomerOtpPurpose, channel: 'sms' | 'email' | 'whatsapp') {
    return {
      'checkout-benefits': {
        sms: options.CUSTOMER_OTP_CHECKOUT_SMS_TEMPLATE,
        email: options.CUSTOMER_OTP_CHECKOUT_EMAIL_TEMPLATE,
        whatsapp: options.CUSTOMER_OTP_CHECKOUT_WHATSAPP_TEMPLATE,
      },
      'order-return': {
        sms: options.CUSTOMER_OTP_RETURN_SMS_TEMPLATE,
        email: options.CUSTOMER_OTP_RETURN_EMAIL_TEMPLATE,
        whatsapp: options.CUSTOMER_OTP_RETURN_WHATSAPP_TEMPLATE,
      },
    }[purpose][channel];
  }
  function assertReady(purpose: CustomerOtpPurpose, channel: 'sms' | 'email' | 'whatsapp') {
    if (
      options.CUSTOMER_OTP_TEMPLATE_CONTRACT !== 'pos-customer-otp-purpose-v1' ||
      !template(purpose, channel)
    )
      throw customerOtpUnavailable();
    if (channel === 'sms' && (!providers.GUPSHUP_SMS_USER_ID || !providers.GUPSHUP_SMS_PASSWORD))
      throw customerOtpUnavailable();
    if (channel === 'email') {
      if (!providers.NETCORE_EMAIL_URL || !providers.NETCORE_API_KEY)
        throw customerOtpUnavailable();
      transport.url(providers.NETCORE_EMAIL_URL);
    }
    if (channel === 'whatsapp') {
      if (
        !providers.WHATSAPP_GUPSHUP_API_URL ||
        !providers.GUPSHUP_WHATSAPP_USER_ID ||
        !providers.GUPSHUP_WHATSAPP_PASSWORD
      )
        throw customerOtpUnavailable();
      transport.url(providers.WHATSAPP_GUPSHUP_API_URL);
    }
  }
  return {
    assertReady,
    async send(id, raw, signal) {
      const parsed = customerOtpPayloadSchema.safeParse(raw);
      if (!parsed.success || !z.uuid().safeParse(id).success) return 'rejected';
      const input = parsed.data;
      if (
        input.channel !== 'email'
          ? !/^[6-9]\d{9}$/.test(input.destination)
          : !z.email().max(96).safeParse(input.destination).success
      )
        return 'rejected';
      let response: Response | undefined;
      try {
        assertReady(input.purpose, input.channel);
        const content = template(input.purpose, input.channel)!.replace('{{code}}', input.code);
        if (input.channel === 'sms') {
          await transport.formPost(
            'https://enterprise.smsgupshup.com/GatewayAPI/rest',
            {
              msg: content,
              v: '1.1',
              userid: providers.GUPSHUP_SMS_USER_ID!,
              password: providers.GUPSHUP_SMS_PASSWORD!,
              send_to: input.destination,
              msg_type: 'text',
              method: 'sendMessage',
              mask: 'TSSOUL',
            },
            signal,
          );
          return 'accepted';
        }
        if (input.channel === 'whatsapp') {
          await transport.formPost(
            providers.WHATSAPP_GUPSHUP_API_URL!,
            {
              userid: providers.GUPSHUP_WHATSAPP_USER_ID!,
              password: providers.GUPSHUP_WHATSAPP_PASSWORD!,
              send_to: input.destination,
              v: '1.1',
              format: 'json',
              msg_type: 'TEXT',
              method: 'SENDMESSAGE',
              msg: content,
              isTemplate: 'true',
              footer: 'This code expires in 5 minutes.',
            },
            signal,
          );
          return 'accepted';
        }
        response = await fetcher(transport.url(providers.NETCORE_EMAIL_URL!), {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          headers: {
            'Content-Type': 'application/json',
            api_key: providers.NETCORE_API_KEY!,
            'Idempotency-Key': id,
          },
          body: JSON.stringify({
            from: { email: 'connect@thesouledstore.com', name: 'The Souled Store' },
            subject:
              input.purpose === 'order-return'
                ? 'Verify your in-store return'
                : 'Verify in-store account benefits',
            content: [{ type: 'html', value: escapeHtml(content) }],
            personalizations: [{ to: [{ email: input.destination, name: 'Customer' }] }],
          }),
        });
        if (!response.ok)
          return response.status >= 400 &&
            response.status < 500 &&
            ![408, 429].includes(response.status)
            ? 'rejected'
            : 'uncertain';
        return z
          .object({ status: z.literal('success') })
          .safeParse(await boundedJson(response, 64000)).success
          ? 'accepted'
          : 'uncertain';
      } catch {
        return 'uncertain';
      } finally {
        await response?.body?.cancel().catch(() => undefined);
      }
    },
  };
}
