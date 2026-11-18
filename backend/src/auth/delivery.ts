import { z } from 'zod';
import type { PasswordIdentity } from './identity.js';
import { AppError } from '../domain/errors.js';
import { boundedJson, boundedText } from '../domain/http-json.js';

export interface OtpDelivery {
  assertReady(account: PasswordIdentity, resend: boolean): void;
  send(account: PasswordIdentity, code: string, resend: boolean): Promise<void>;
}
const optionalText = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
export type PhoneOtpChannel = 'sms' | 'whatsapp';
export interface PhoneOtpDelivery {
  assertReady(channel: PhoneOtpChannel): void;
  send(phone: string, code: string, channel: PhoneOtpChannel): Promise<void>;
}
const uncertain = () =>
  new AppError(
    502,
    'OTP_DELIVERY_UNCERTAIN',
    'OTP delivery could not be confirmed. If the code arrives, you can use it; otherwise request a new one after the cooldown.',
  );
/** Reusable HTTPS/body-only OTP transport; callers supply their approved purpose-specific template. */
export function createOtpTransport(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
) {
  const options = z
    .object({
      NETCORE_EMAIL_URL: optionalText,
      NETCORE_API_KEY: optionalText,
      GUPSHUP_SMS_USER_ID: optionalText,
      GUPSHUP_SMS_PASSWORD: optionalText,
      WHATSAPP_GUPSHUP_API_URL: optionalText,
      GUPSHUP_WHATSAPP_USER_ID: optionalText,
      GUPSHUP_WHATSAPP_PASSWORD: optionalText,
    })
    .parse(env);
  function url(raw: string) {
    let value: URL;
    try {
      value = new URL(raw);
    } catch {
      throw new AppError(
        503,
        'OTP_DELIVERY_UNAVAILABLE',
        'OTP delivery requires a configured HTTPS endpoint.',
      );
    }
    if (
      value.protocol !== 'https:' ||
      value.username ||
      value.password ||
      value.search ||
      value.hash
    )
      throw new AppError(
        503,
        'OTP_DELIVERY_UNAVAILABLE',
        'Login delivery requires a configured HTTPS endpoint.',
      );
    return value;
  }
  async function formPost(
    endpoint: string,
    parameters: Record<string, string>,
    signal?: AbortSignal,
  ) {
    // Gupshup documents POST form parameters for this gateway. Credentials,
    // phone and OTP stay out of URLs: EnterpriseAPIDocument.pdf §10.9/10.10.
    const response = await fetcher(url(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Delivery rejected');
    }
    const text = await boundedText(response, 64000);
    let accepted = /^\s*success\s*\|/i.test(text);
    if (!accepted) {
      try {
        accepted = z
          .object({ response: z.object({ status: z.literal('success') }) })
          .safeParse(JSON.parse(text) as unknown).success;
      } catch {
        /* An unrecognized response is not a delivery acknowledgment. */
      }
    }
    if (!accepted) throw new Error('Delivery not accepted');
  }
  return { options, url, formPost };
}
function phoneSender(transport: ReturnType<typeof createOtpTransport>): PhoneOtpDelivery {
  const { options, url, formPost } = transport;
  function assertReady(channel: PhoneOtpChannel) {
    if (channel === 'sms' && (!options.GUPSHUP_SMS_USER_ID || !options.GUPSHUP_SMS_PASSWORD))
      throw new AppError(503, 'OTP_DELIVERY_UNAVAILABLE', 'SMS delivery is not configured.');
    if (channel === 'whatsapp') {
      if (
        !options.WHATSAPP_GUPSHUP_API_URL ||
        !options.GUPSHUP_WHATSAPP_USER_ID ||
        !options.GUPSHUP_WHATSAPP_PASSWORD
      )
        throw new AppError(503, 'OTP_DELIVERY_UNAVAILABLE', 'WhatsApp delivery is not configured.');
      url(options.WHATSAPP_GUPSHUP_API_URL);
    }
  }
  return {
    assertReady,
    async send(phone, code, channel) {
      assertReady(channel);
      if (!phone || phone.length > 32 || !/^\d{6}$/.test(code))
        throw new AppError(
          400,
          'OTP_DELIVERY_INPUT_INVALID',
          'OTP delivery parameters are invalid.',
        );
      try {
        if (channel === 'sms')
          await formPost('https://enterprise.smsgupshup.com/GatewayAPI/rest', {
            msg: `${code} is your OTP to log in to The Souled Store.`,
            v: '1.1',
            userid: options.GUPSHUP_SMS_USER_ID!,
            password: options.GUPSHUP_SMS_PASSWORD!,
            send_to: phone,
            msg_type: 'text',
            method: 'sendMessage',
            mask: 'TSSOUL',
          });
        else
          await formPost(options.WHATSAPP_GUPSHUP_API_URL!, {
            userid: options.GUPSHUP_WHATSAPP_USER_ID!,
            password: options.GUPSHUP_WHATSAPP_PASSWORD!,
            send_to: phone,
            v: '1.1',
            format: 'json',
            msg_type: 'TEXT',
            method: 'SENDMESSAGE',
            msg: `${code} is your verification code. For your security, do not share this code.`,
            isTemplate: 'true',
            footer: 'This code expires in 10 minute.',
          });
      } catch {
        throw uncertain();
      }
    },
  };
}
/** Shared delivery transport; each caller owns identity proof, TTL and retry policy. */
export function phoneOtpDelivery(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): PhoneOtpDelivery {
  return phoneSender(createOtpTransport(env, fetcher));
}
export function otpDelivery(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): OtpDelivery {
  const transport = createOtpTransport(env, fetcher),
    { options, url } = transport,
    phone = phoneSender(transport);
  function assertReady(account: PasswordIdentity, resend: boolean) {
    if (!account.phone)
      throw new AppError(
        503,
        'OTP_CONTACT_UNAVAILABLE',
        'Ask your administrator to configure your login contact.',
      );
    if (
      account.otpMethod === 'email' &&
      (!account.contactEmail || !options.NETCORE_EMAIL_URL || !options.NETCORE_API_KEY)
    )
      throw new AppError(
        503,
        'OTP_DELIVERY_UNAVAILABLE',
        'Login email delivery is not configured.',
      );
    if (
      account.otpMethod === 'sms' &&
      (!options.GUPSHUP_SMS_USER_ID || !options.GUPSHUP_SMS_PASSWORD)
    )
      throw new AppError(503, 'OTP_DELIVERY_UNAVAILABLE', 'Login SMS delivery is not configured.');
    if (
      resend &&
      (!options.WHATSAPP_GUPSHUP_API_URL ||
        !options.GUPSHUP_WHATSAPP_USER_ID ||
        !options.GUPSHUP_WHATSAPP_PASSWORD)
    )
      throw new AppError(
        503,
        'OTP_DELIVERY_UNAVAILABLE',
        'Login resend delivery is not configured.',
      );
    if (account.otpMethod === 'email') url(options.NETCORE_EMAIL_URL!);
    else phone.assertReady('sms');
    if (resend) phone.assertReady('whatsapp');
  }
  return {
    assertReady,
    async send(account, code, resend) {
      assertReady(account, resend);
      try {
        if (account.otpMethod === 'email') {
          const response = await fetcher(url(options.NETCORE_EMAIL_URL!), {
            method: 'POST',
            headers: { api_key: options.NETCORE_API_KEY!, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: { email: 'connect@thesouledstore.com', name: 'The Souled Store' },
              subject: 'POS login OTP',
              content: [
                {
                  type: 'html',
                  // Legacy core/tasks.py:110 passes user_obj.first_name into an f-string
                  // (helpers/helpers.py:1478), so a NULL name renders as 'None'.
                  value: `Hey ${escapeHtml(account.firstName ?? 'None')},\n\n${code} is your OTP to login into the POS Admin.\n\nHave a soulful day!\nThe Souled Store Team`,
                },
              ],
              personalizations: [
                {
                  to: [{ email: account.contactEmail!, name: account.contactEmail!.split('@')[0] }],
                },
              ],
            }),
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          });
          if (!response.ok) throw new Error('Delivery rejected');
          z.object({ status: z.literal('success') }).parse(await boundedJson(response, 64000));
        } else await phone.send(account.phone!, code, 'sms');
        if (resend) await phone.send(account.phone!, code, 'whatsapp');
      } catch {
        throw uncertain();
      }
    },
  };
}
