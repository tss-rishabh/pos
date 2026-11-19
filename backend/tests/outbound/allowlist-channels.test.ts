import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import {
  liveLoginOtpTransport,
  loginDeliveryOptions,
  phoneOtpDelivery,
} from '../../src/auth/delivery.js';
import { netcoreDiscountMailer } from '../../src/modules/checkout/discounts/delivery.js';
import { orderSmsHandler } from '../../src/modules/checkout/order-sms.js';
import { returnGateway } from '../../src/modules/checkout/return-workflow/gateway.js';
import { customerOtpApiV2 } from '../../src/modules/customer-otp/api-v2.js';
import { fulfillmentEffects } from '../../src/modules/fulfillment/effects.js';
import { readFulfillmentOptions } from '../../src/modules/fulfillment/options.js';
import { createGiftCardBatchDelivery } from '../../src/modules/gift-card-batches/delivery.js';
import { readGiftCardBatchOptions } from '../../src/modules/gift-card-batches/options.js';
import { invoiceAdapter } from '../../src/modules/invoice-documents/adapter.js';
import { invoiceDocumentOptions } from '../../src/modules/invoice-documents/options.js';
import { hyperlocalGateway } from '../../src/modules/legacy-fulfillment/gateway.js';
import { readLegacyFulfillmentOptions } from '../../src/modules/legacy-fulfillment/options.js';
import { postSlackText } from '../../src/modules/operational-reports/slack.js';
import { resetOutboundAllowlist } from '../../src/outbound/allowlist.js';
import {
  listedEmail,
  listedPhone,
  listedWebhook,
  recordingFetch,
  unlistedEmail,
  unlistedPhone,
  unlistedWebhook,
  useAllowlist,
  type Mode,
} from './harness.js';

/**
 * Per-channel cases: allowed (listed recipient, request identical to the disabled guard),
 * suppressed (unlisted recipient: no request, one `outbound.suppressed` event, success result)
 * and disabled (every recipient is sent to, no event).
 */
const providerEnv = {
  GUPSHUP_SMS_USER_ID: 'fixture-user',
  GUPSHUP_SMS_PASSWORD: 'fixture-provider-secret',
  GUPSHUP_WHATSAPP_USER_ID: 'fixture-wa',
  GUPSHUP_WHATSAPP_PASSWORD: 'fixture-wa-secret',
  WHATSAPP_GUPSHUP_API_URL: 'https://mediaapi.example.test/GatewayAPI/rest',
  NETCORE_EMAIL_URL: 'https://mail.example.test/v5/mail/send',
  NETCORE_API_KEY: 'fixture-api-key',
  LOGIN_OTP_DELIVERY: 'live',
};
const apiBase = 'https://api.example.test/api/v2/';
const mailr = 'https://mailr.example.test/';
const jobContext = {
  jobId: 'job-1',
  name: 'core.tasks.send_sms' as const,
  requestId: null,
  userId: null,
  signal: new AbortController().signal,
};
const gupshupSuccess = () => new Response('success | 9000000001 | fixture-id');
const json = (value: unknown) => () => new Response(JSON.stringify(value), { status: 200 });

interface Case {
  name: string;
  channel: string;
  module: string;
  flow: string;
  reply?: () => Response;
  /** Sends to the listed or the unlisted recipient through the real adapter. */
  send(fetcher: typeof fetch, listed: boolean): Promise<unknown>;
  /** Result fields that must match between a real and a suppressed send. */
  shape?: (result: unknown) => unknown;
}
const statusOnly = (result: unknown) => (result as { status: number }).status;
const cases: Case[] = [
  {
    name: 'SMS: staff login OTP (Gupshup)',
    channel: 'sms',
    module: 'identity',
    flow: 'staff-login-otp',
    send: (fetcher, listed) =>
      liveLoginOtpTransport(loginDeliveryOptions(providerEnv, 'test'), fetcher).sms(
        listed ? listedPhone : unlistedPhone,
        'fixture text',
      ),
  },
  {
    name: 'SMS: customer registration OTP (Gupshup)',
    channel: 'sms',
    module: 'checkout',
    flow: 'customer-registration-otp',
    reply: gupshupSuccess,
    send: (fetcher, listed) =>
      phoneOtpDelivery(providerEnv, fetcher).send(
        listed ? listedPhone : unlistedPhone,
        '123456',
        'sms',
      ),
  },
  {
    name: 'WhatsApp: staff login OTP resend (Gupshup)',
    channel: 'whatsapp',
    module: 'identity',
    flow: 'staff-login-otp-resend',
    reply: gupshupSuccess,
    send: (fetcher, listed) =>
      liveLoginOtpTransport(loginDeliveryOptions(providerEnv, 'test'), fetcher).whatsapp(
        listed ? listedPhone : unlistedPhone,
        'fixture text',
        'fixture footer',
      ),
  },
  {
    name: 'WhatsApp: customer registration OTP fallback (Gupshup)',
    channel: 'whatsapp',
    module: 'checkout',
    flow: 'customer-registration-otp',
    reply: gupshupSuccess,
    send: (fetcher, listed) =>
      phoneOtpDelivery(providerEnv, fetcher).send(
        listed ? listedPhone : unlistedPhone,
        '123456',
        'whatsapp',
      ),
  },
  {
    name: 'Email: staff login OTP (Netcore)',
    channel: 'email',
    module: 'identity',
    flow: 'staff-login-otp',
    send: (fetcher, listed) =>
      liveLoginOtpTransport(loginDeliveryOptions(providerEnv, 'test'), fetcher).email({
        to: listed ? listedEmail : unlistedEmail,
        toName: 'fixture',
        subject: 'POS login OTP',
        html: 'fixture',
      }),
  },
  {
    name: 'Email: PG discount mail (Netcore)',
    channel: 'email',
    module: 'checkout',
    flow: 'pg-discount-mail',
    reply: json({ message: 'OK' }),
    send: (fetcher, listed) =>
      netcoreDiscountMailer(
        { url: providerEnv.NETCORE_EMAIL_URL, apiKey: providerEnv.NETCORE_API_KEY },
        fetcher,
      ).send({ to: listed ? listedEmail : unlistedEmail, subject: 'fixture', html: 'fixture' }),
  },
  {
    name: 'Email: gift-card batch archive (Netcore)',
    channel: 'email',
    module: 'gift-card-batches',
    flow: 'gift-card-batch-mail',
    reply: json({ message: 'OK' }),
    send: (fetcher, listed) =>
      createGiftCardBatchDelivery(readGiftCardBatchOptions(providerEnv), fetcher)!.send({
        collectionId: '1',
        recipient: listed ? listedEmail : unlistedEmail,
        archive: Buffer.from('fixture-archive'),
      }),
  },
  {
    name: 'Slack: login security alert',
    channel: 'slack',
    module: 'identity',
    flow: 'login-security-alert',
    send: (fetcher, listed) =>
      liveLoginOtpTransport(
        loginDeliveryOptions(
          {
            ...providerEnv,
            LOGIN_SECURITY_SLACK_WEBHOOK: listed ? listedWebhook : unlistedWebhook,
          },
          'test',
        ),
        fetcher,
      ).slack('login-security', 'fixture alert'),
  },
  {
    name: 'Slack: scheduled reports and finance alerts',
    channel: 'slack',
    module: 'operational-reports',
    flow: 'report-slack-post',
    async send(fetcher, listed) {
      vi.stubGlobal('fetch', fetcher);
      return postSlackText(listed ? listedWebhook : unlistedWebhook, 'fixture report');
    },
  },
  {
    name: 'Slack: express fulfillment alert',
    channel: 'slack',
    module: 'fulfillment',
    flow: 'fulfillment-slack-alert',
    send: (fetcher, listed) =>
      fulfillmentEffects({} as Databases, readFulfillmentOptions({}), { fetch: fetcher }).slack(
        'fixture alert',
        { slackUrl: listed ? listedWebhook : unlistedWebhook },
      ),
  },
  {
    name: 'Slack: hyperlocal alert',
    channel: 'slack',
    module: 'legacy-fulfillment',
    flow: 'hyperlocal-slack-alert',
    shape: statusOnly,
    send: (fetcher, listed) =>
      hyperlocalGateway({ NODE_ENV: 'test' }, readLegacyFulfillmentOptions({}), fetcher).slack(
        { url: listed ? listedWebhook : unlistedWebhook },
        'fixture alert',
      ),
  },
  {
    name: 'Slack: exchange alert',
    channel: 'slack',
    module: 'checkout',
    flow: 'exchange-alert',
    send: (fetcher, listed) =>
      returnGateway({ NODE_ENV: 'test' } as Config, {}, fetcher).slack({
        message: 'fixture alert',
        storeId: '7',
        staffUser: '',
        storeSlackUrl: listed ? listedWebhook : unlistedWebhook,
      }),
  },
  {
    name: 'API-v2: order SMS job (omnichannel-sms)',
    channel: 'api-v2',
    module: 'checkout',
    flow: 'order-sms',
    send: (fetcher, listed) =>
      orderSmsHandler({ TSS_API_BASE_URL: apiBase }, fetcher)(
        { order_id: listed ? 101 : 102 },
        jobContext,
      ),
  },
  {
    name: 'API-v2: customer OTP (omnichannel-sendotp)',
    channel: 'api-v2',
    module: 'customer-otp',
    flow: 'customer-otp',
    reply: json({ mobile: true, email: true }),
    send: (fetcher, listed) =>
      customerOtpApiV2({ TSS_API_BASE_URL: apiBase, NODE_ENV: 'test' }, fetcher).sendOtp(
        listed ? 201n : 202n,
      ),
  },
  {
    name: 'API-v2: WhatsApp invoice (mailr send-invoice-whatsapp)',
    channel: 'api-v2',
    module: 'invoice-documents',
    flow: 'whatsapp-invoice',
    send: (fetcher, listed) =>
      invoiceAdapter(
        { NODE_ENV: 'test' },
        invoiceDocumentOptions({ MJML_HOST: mailr }),
        fetcher,
      ).sendWhatsappInvoice(listed ? '101' : '102'),
  },
  {
    name: 'API-v2: return mail (mailr omnichannel-return-order)',
    channel: 'api-v2',
    module: 'checkout',
    flow: 'return-mail',
    send: (fetcher, listed) =>
      returnGateway({ NODE_ENV: 'test' } as Config, { mailHost: mailr }, fetcher).returnMail({
        orderId: listed ? '101' : '102',
        productId: '5',
        storeId: '7',
        lineId: '9',
      }),
  },
  {
    name: 'API-v2: exchange mail (mailr exchange)',
    channel: 'api-v2',
    module: 'checkout',
    flow: 'exchange-mail',
    send: (fetcher, listed) =>
      returnGateway({ NODE_ENV: 'test' } as Config, { mailHost: mailr }, fetcher).exchangeMail({
        orderId: listed ? '101' : '102',
        productId: '5',
        lineId: null,
      }),
  },
  {
    name: 'API-v2: express out-for-delivery mail (mailr)',
    channel: 'api-v2',
    module: 'fulfillment',
    flow: 'out-for-delivery-mail',
    send: (fetcher, listed) =>
      fulfillmentEffects({} as Databases, readFulfillmentOptions({ MJML_HOST: mailr }), {
        fetch: fetcher,
      }).outForDelivery(listed ? '101' : '102', 'AWB1'),
  },
  {
    name: 'API-v2: hyperlocal new-order communication (mailr)',
    channel: 'api-v2',
    module: 'legacy-fulfillment',
    flow: 'hyperlocal-new-order-mail',
    shape: statusOnly,
    send: (fetcher, listed) =>
      hyperlocalGateway(
        { NODE_ENV: 'test' },
        readLegacyFulfillmentOptions({ MJML_HOST: mailr }),
        fetcher,
      ).newOrderCommunication(listed ? '101' : '102'),
  },
  {
    name: 'OneDirect: hyperlocal conversion ticket (API-v2 create-od-ticket)',
    channel: 'onedirect',
    module: 'legacy-fulfillment',
    flow: 'onedirect-ticket',
    shape: statusOnly,
    send: (fetcher, listed) =>
      hyperlocalGateway(
        { NODE_ENV: 'test' },
        readLegacyFulfillmentOptions({ MAIN_API_V2_URL: apiBase }),
        fetcher,
      ).createOdTicket({
        orderId: listed ? '101' : '102',
        name: 'fixture',
        subject: 'fixture',
        description: 'fixture',
      }),
  },
];

async function run(item: Case, mode: Mode, listed: boolean) {
  const events = useAllowlist(mode),
    { requests, fetcher } = recordingFetch(item.reply);
  const result = await item.send(fetcher, listed);
  return { events, requests, result: (item.shape ?? ((value: unknown) => value))(result) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetOutboundAllowlist();
});

describe.each(cases)('$name', (item) => {
  it('disabled: sends to any recipient and logs nothing', async () => {
    const outcome = await run(item, 'disabled', false);
    expect(outcome.requests.length).toBeGreaterThan(0);
    expect(outcome.events).toEqual([]);
  });
  it('allowed: an allowlisted recipient gets byte-identical requests to the disabled guard', async () => {
    const disabled = await run(item, 'disabled', true),
      allowed = await run(item, 'allowed', true);
    expect(allowed.requests.length).toBeGreaterThan(0);
    expect(allowed.requests).toEqual(disabled.requests);
    expect(allowed.result).toEqual(disabled.result);
    expect(allowed.events).toEqual([]);
  });
  it('suppressed: no request, one outbound.suppressed event, the success result', async () => {
    const sent = await run(item, 'allowed', true),
      suppressed = await run(item, 'suppressed', false);
    expect(suppressed.requests).toEqual([]);
    expect(suppressed.result).toEqual(sent.result);
    expect(suppressed.events).toHaveLength(1);
    expect(suppressed.events[0]).toMatchObject({
      eventId: 'outbound.suppressed',
      channel: item.channel,
      module: item.module,
      flow: item.flow,
      resource: 'outbound-message',
      traceId: null,
      userId: null,
    });
    // The event never carries a recipient, a webhook or a message body.
    const logged = JSON.stringify(
      suppressed.events.map(({ eventInstanceId: _random, ...event }) => event),
    );
    for (const secret of [unlistedPhone, unlistedEmail, unlistedWebhook, 'fixture', '102', '202'])
      expect(logged).not.toContain(secret);
  });
});
