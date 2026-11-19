import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { boundedText } from '../domain/http-json.js';
import type { AuthEventLogger } from './events.js';
import { outboundAllowlistEnabled, outboundPermitted } from '../outbound/allowlist.js';

const optionalText = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
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
      // Allowlist guard (w25): a suppressed OTP resolves like a delivered one.
      if (
        outboundAllowlistEnabled() &&
        !(await outboundPermitted({
          channel,
          module: 'checkout',
          flow: 'customer-registration-otp',
          targets: [{ kind: 'phone', value: phone }],
        }))
      )
        return;
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

// ---- Staff login OTP delivery (legacy core/tasks.py:83-144) -------------------------------

/** What the login flow knows about the recipient. Never logged. */
export interface LoginOtpRecipient {
  userId: string;
  phone: string;
  contactEmail: string | null;
  firstName: string;
  /** pos_user.otp_method: 1 = mobile, 2 = email. */
  otpMethod: number;
}
export interface LoginOtpEmail {
  to: string;
  toName: string;
  subject: string;
  html: string;
}
/**
 * Provider adapters. The live adapter talks to Netcore, Gupshup and Slack; the sandbox
 * adapter records messages in memory and sends nothing (tests, local development).
 */
export interface LoginOtpTransport {
  readonly mode: 'live' | 'sandbox';
  email(message: LoginOtpEmail): Promise<void>;
  sms(phone: string, text: string): Promise<void>;
  /** True when Gupshup's reply contains "success" (legacy helpers.py:1534). */
  whatsapp(phone: string, text: string, footer: string): Promise<boolean>;
  /** Posts `{text}` to the named Slack webhook; a missing webhook is a silent no-op (legacy). */
  slack(channel: 'login-security' | 'whatsapp-alert', text: string): Promise<void>;
}
export function loginDeliveryOptions(
  env: NodeJS.ProcessEnv = process.env,
  nodeEnv: 'development' | 'test' | 'production' = 'development',
) {
  const options = z
    .object({
      LOGIN_OTP_DELIVERY: z.preprocess(
        (value) => (value === '' || value === undefined ? undefined : value),
        z.enum(['live', 'sandbox']).optional(),
      ),
      NETCORE_EMAIL_URL: optionalText,
      NETCORE_API_KEY: optionalText,
      GUPSHUP_SMS_USER_ID: optionalText,
      GUPSHUP_SMS_PASSWORD: optionalText,
      WHATSAPP_GUPSHUP_API_URL: optionalText,
      GUPSHUP_WHATSAPP_USER_ID: optionalText,
      GUPSHUP_WHATSAPP_PASSWORD: optionalText,
      LOGIN_SECURITY_SLACK_WEBHOOK: optionalText,
      SLACK_WHATSAPP_ALERT_WEBHOOK: optionalText,
      SERVICE_NAME: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().max(100).default('backend-pos-web'),
      ),
    })
    .parse(env);
  const mode = options.LOGIN_OTP_DELIVERY ?? (nodeEnv === 'production' ? 'live' : 'sandbox');
  if (nodeEnv === 'production' && mode !== 'live')
    throw new Error('LOGIN_OTP_DELIVERY=sandbox is forbidden in production.');
  return { ...options, mode };
}
export type LoginDeliveryOptions = ReturnType<typeof loginDeliveryOptions>;
const notConfigured = () => new Error('Delivery provider is not configured');
function httpsEndpoint(raw: string | undefined, hosts?: readonly string[]): URL {
  if (!raw) throw notConfigured();
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (hosts && !hosts.includes(url.hostname))
  )
    throw notConfigured();
  return url;
}
/** Slack text as legacy `Helpers.send_slack_alert` formats it (helpers.py:1544-1553). */
export function slackAlertText(message: string, serviceName: string): string {
  const space = message.indexOf(' ');
  const emoji = space < 0 ? message : message.slice(0, space),
    body = space < 0 ? '' : message.slice(space + 1);
  return `${emoji} *[${serviceName}]* ${body}`;
}
export function liveLoginOtpTransport(
  options: LoginDeliveryOptions,
  fetcher: typeof fetch = fetch,
): LoginOtpTransport {
  async function form(endpoint: URL, parameters: Record<string, string>, timeoutMs: number) {
    // S11: Gupshup accepts the same parameters as a POST form body. Credentials, phone and
    // OTP stay out of URLs (legacy sent them as GET query parameters).
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    return response;
  }
  return {
    mode: 'live',
    async email(message) {
      if (!options.NETCORE_API_KEY) throw notConfigured();
      if (
        outboundAllowlistEnabled() &&
        !(await outboundPermitted({
          channel: 'email',
          module: 'identity',
          flow: 'staff-login-otp',
          targets: [{ kind: 'email', value: message.to }],
        }))
      )
        return;
      const response = await fetcher(httpsEndpoint(options.NETCORE_EMAIL_URL), {
        method: 'POST',
        headers: { api_key: options.NETCORE_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: { email: 'connect@thesouledstore.com', name: 'The Souled Store' },
          subject: message.subject,
          content: [{ type: 'html', value: message.html }],
          personalizations: [{ to: [{ email: message.to, name: message.toName }] }],
        }),
        // S12: legacy had no timeout on this synchronous request-thread call.
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error('Email rejected');
    },
    async sms(phone, text) {
      if (!options.GUPSHUP_SMS_USER_ID || !options.GUPSHUP_SMS_PASSWORD) throw notConfigured();
      if (
        outboundAllowlistEnabled() &&
        !(await outboundPermitted({
          channel: 'sms',
          module: 'identity',
          flow: 'staff-login-otp',
          targets: [{ kind: 'phone', value: phone }],
        }))
      )
        return;
      const response = await form(
        httpsEndpoint('https://enterprise.smsgupshup.com/GatewayAPI/rest'),
        {
          msg: text,
          v: '1.1',
          userid: options.GUPSHUP_SMS_USER_ID,
          password: options.GUPSHUP_SMS_PASSWORD,
          send_to: phone,
          msg_type: 'text',
          method: 'sendMessage',
          mask: 'TSSOUL',
        },
        5000,
      );
      // Legacy logs the reply and treats every completed request as sent.
      await response.body?.cancel().catch(() => undefined);
    },
    async whatsapp(phone, text, footer) {
      if (!options.GUPSHUP_WHATSAPP_USER_ID || !options.GUPSHUP_WHATSAPP_PASSWORD)
        throw notConfigured();
      // A suppressed WhatsApp resend reports Gupshup's "success", so no failure alert follows.
      if (
        outboundAllowlistEnabled() &&
        !(await outboundPermitted({
          channel: 'whatsapp',
          module: 'identity',
          flow: 'staff-login-otp-resend',
          targets: [{ kind: 'phone', value: phone }],
        }))
      )
        return true;
      const response = await form(
        httpsEndpoint(
          options.WHATSAPP_GUPSHUP_API_URL ?? 'https://mediaapi.smsgupshup.com/GatewayAPI/rest',
        ),
        {
          userid: options.GUPSHUP_WHATSAPP_USER_ID,
          password: options.GUPSHUP_WHATSAPP_PASSWORD,
          send_to: phone,
          v: '1.1',
          format: 'json',
          msg_type: 'TEXT',
          method: 'SENDMESSAGE',
          msg: text,
          isTemplate: 'true',
          footer,
        },
        10000,
      );
      return (await boundedText(response, 64000)).toLowerCase().includes('success');
    },
    async slack(channel, text) {
      const raw =
        channel === 'login-security'
          ? (options.LOGIN_SECURITY_SLACK_WEBHOOK ?? options.SLACK_WHATSAPP_ALERT_WEBHOOK)
          : options.SLACK_WHATSAPP_ALERT_WEBHOOK;
      if (!raw) return;
      const webhook = httpsEndpoint(raw, ['hooks.slack.com', 'hooks.slack-gov.com']);
      if (
        outboundAllowlistEnabled() &&
        !(await outboundPermitted({
          channel: 'slack',
          module: 'identity',
          flow: channel === 'login-security' ? 'login-security-alert' : 'whatsapp-failure-alert',
          targets: [{ kind: 'slack-webhook', value: raw }],
        }))
      )
        return;
      const response = await fetcher(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error('Slack rejected');
    },
  };
}
export interface SandboxMessage {
  channel: 'email' | 'sms' | 'whatsapp' | 'slack';
  to: string;
  text: string;
}
/** Records messages in memory and sends nothing. Never enabled in production. */
export function sandboxLoginOtpTransport(
  whatsappSucceeds: () => boolean = () => true,
): LoginOtpTransport & { sent: SandboxMessage[] } {
  const sent: SandboxMessage[] = [];
  return {
    mode: 'sandbox',
    sent,
    async email(message) {
      sent.push({ channel: 'email', to: message.to, text: message.html });
    },
    async sms(phone, text) {
      sent.push({ channel: 'sms', to: phone, text });
    },
    async whatsapp(phone, text) {
      sent.push({ channel: 'whatsapp', to: phone, text });
      return whatsappSucceeds();
    },
    async slack(channel, text) {
      sent.push({ channel: 'slack', to: channel, text });
    },
  };
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
/** Legacy `Helpers._mask_phone` (helpers.py:1507-1509). */
export function maskPhone(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 2)}****${phone.slice(-2)}` : '****';
}
/** Legacy `Helpers.send_otp_mail` body, including its template indentation (helpers.py:1477-1492). */
export function loginOtpEmailBody(firstName: string, code: string): string {
  // S12: the first name is HTML-escaped; legacy interpolated it raw into an HTML part.
  return `Hey ${escapeHtml(firstName)},\n\n        ${code} is your OTP to login into the POS Admin.\n\n        Have a soulful day!\n        The Souled Store Team`;
}
export interface LoginOtpDelivery {
  /**
   * Sends on the user's channel inside the request, as legacy does: email when
   * `otp_method == 2` and a contact email exists, SMS when `otp_method == 1`, otherwise
   * nothing. Provider failures are logged and swallowed. A resend also goes on WhatsApp,
   * off the request path, with a Slack alert when WhatsApp does not confirm delivery.
   */
  deliver(recipient: LoginOtpRecipient, code: string, resend: boolean): Promise<void>;
  /** Fire-and-forget Slack alert to the login security channel. */
  alert(message: string): void;
  /** Waits for background sends (tests, shutdown). */
  drain(): Promise<void>;
}
export function loginOtpDelivery(
  transport: LoginOtpTransport,
  log: AuthEventLogger,
  serviceName = 'backend-pos-web',
): LoginOtpDelivery {
  const background = new Set<Promise<void>>();
  function detach(task: () => Promise<void>) {
    const promise = task().finally(() => background.delete(promise));
    background.add(promise);
  }
  function slack(
    channel: 'login-security' | 'whatsapp-alert',
    message: string,
    userId: string | null,
  ) {
    detach(async () => {
      try {
        await transport.slack(channel, slackAlertText(message, serviceName));
      } catch {
        log({ eventId: 'identity.login-otp.alert-failed', userId, level: 'error' });
      }
    });
  }
  return {
    async deliver(recipient, code, resend) {
      if (recipient.contactEmail && recipient.otpMethod === 2) {
        try {
          await transport.email({
            to: recipient.contactEmail,
            toName: recipient.contactEmail.split('@')[0] ?? recipient.contactEmail,
            subject: 'POS login OTP',
            html: loginOtpEmailBody(recipient.firstName, code),
          });
        } catch {
          log({
            eventId: 'identity.login-otp.email-failed',
            userId: recipient.userId,
            level: 'error',
          });
        }
      } else if (recipient.otpMethod === 1) {
        try {
          await transport.sms(
            recipient.phone,
            `${code} is your OTP to log in to The Souled Store.`,
          );
        } catch {
          log({
            eventId: 'identity.login-otp.sms-failed',
            userId: recipient.userId,
            level: 'error',
          });
        }
      }
      if (!resend) return;
      const context = `staff_login|user_id:${recipient.userId}`;
      detach(async () => {
        let delivered = false;
        try {
          delivered = await transport.whatsapp(
            recipient.phone,
            `${code} is your verification code. For your security, do not share this code.`,
            'This code expires in 10 minute.',
          );
        } catch {
          delivered = false;
        }
        if (delivered) return;
        log({
          eventId: 'identity.login-otp.whatsapp-failed',
          userId: recipient.userId,
          level: 'error',
        });
        slack(
          'whatsapp-alert',
          `:warning: WhatsApp OTP delivery failed | flow: \`${context}\` | phone: \`${maskPhone(recipient.phone)}\``,
          recipient.userId,
        );
      });
    },
    alert(message) {
      slack('login-security', message, null);
    },
    async drain() {
      while (background.size) await Promise.allSettled([...background]);
    },
  };
}
