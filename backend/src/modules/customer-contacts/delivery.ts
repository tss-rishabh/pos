import { z } from 'zod';
import { createOtpTransport } from '../../auth/delivery.js';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { operationHash } from '../checkout/crypto.js';
import {
  contactEffectsContract,
  contactEffectPayload,
  contactOtpPayload,
  type CustomerContactDelivery,
} from './contracts.js';
import type { CustomerContactOptions } from './options.js';

const unavailable = () =>
  new AppError(
    503,
    'CUSTOMER_CONTACT_DELIVERY_UNAVAILABLE',
    'Customer contact verification and synchronization require configured delivery.',
  );
export function createCustomerContactDelivery(
  config: Pick<Config, 'DEMO_MODE'>,
  options: CustomerContactOptions,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): CustomerContactDelivery | undefined {
  if (config.DEMO_MODE || !options.CUSTOMER_CONTACTS_ENABLED) return undefined;
  const transport = createOtpTransport(env, fetcher),
    providers = transport.options;
  const effects = options.CUSTOMER_CONTACT_EFFECTS_URL
    ? transport.url(options.CUSTOMER_CONTACT_EFFECTS_URL)
    : undefined;
  function assertReady(channel: 'sms' | 'email') {
    if (
      channel === 'sms' &&
      (!providers.GUPSHUP_SMS_USER_ID ||
        !providers.GUPSHUP_SMS_PASSWORD ||
        !options.CUSTOMER_CONTACT_SMS_TEMPLATE)
    )
      throw unavailable();
    if (channel === 'email') {
      if (!providers.NETCORE_EMAIL_URL || !providers.NETCORE_API_KEY) throw unavailable();
      transport.url(providers.NETCORE_EMAIL_URL);
    }
  }
  function assertEffectsReady() {
    if (
      !effects ||
      !options.CUSTOMER_CONTACT_EFFECTS_KEY ||
      options.CUSTOMER_CONTACT_EFFECTS_CONTRACT !== contactEffectsContract ||
      !options.CUSTOMER_CONTACT_EFFECTS_REPLAY_SAFE
    )
      throw unavailable();
  }
  async function accepted(response: Response) {
    if (!response.ok)
      return response.status >= 400 &&
        response.status < 500 &&
        ![408, 429].includes(response.status)
        ? ('rejected' as const)
        : ('uncertain' as const);
    const value = await boundedJson(response, 64000);
    return z.object({ status: z.literal('success') }).safeParse(value).success
      ? ('accepted' as const)
      : ('uncertain' as const);
  }
  return {
    assertReady,
    assertEffectsReady,
    async sendOtp(id, raw, signal) {
      const parsed = contactOtpPayload.safeParse(raw);
      if (!parsed.success || !z.uuid().safeParse(id).success) return 'rejected';
      const input = parsed.data;
      if (
        input.channel === 'sms'
          ? !/^[6-9]\d{9}$/.test(input.destination)
          : !z.email().max(96).safeParse(input.destination).success
      )
        return 'rejected';
      let response: Response | undefined;
      try {
        assertReady(input.channel);
        if (input.channel === 'sms') {
          await transport.formPost(
            'https://enterprise.smsgupshup.com/GatewayAPI/rest',
            {
              msg: options.CUSTOMER_CONTACT_SMS_TEMPLATE!.replace('{{code}}', input.code),
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
        response = await fetcher(transport.url(providers.NETCORE_EMAIL_URL!), {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            api_key: providers.NETCORE_API_KEY!,
            'Idempotency-Key': id,
          },
          body: JSON.stringify({
            from: { email: 'connect@thesouledstore.com', name: 'The Souled Store' },
            subject: 'Customer contact verification',
            content: [
              {
                type: 'html',
                value: `${input.code} is your verification code for the contact change you requested at The Souled Store. Use it only for this request.`,
              },
            ],
            personalizations: [{ to: [{ email: input.destination, name: 'Customer' }] }],
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        return await accepted(response);
      } catch {
        return 'uncertain';
      } finally {
        await response?.body?.cancel().catch(() => undefined);
      }
    },
    async sourceEffects(id, raw, signal) {
      const parsed = contactEffectPayload.safeParse(raw);
      if (!parsed.success || !z.uuid().safeParse(id).success) return 'rejected';
      let response: Response | undefined;
      try {
        assertEffectsReady();
        const payload = parsed.data,
          key = options.CUSTOMER_CONTACT_EFFECTS_KEY!,
          bodyHash = operationHash(contactEffectsContract, payload, key);
        response = await fetcher(effects!, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            'X-Customer-Contact-Key': key,
            'X-Customer-Contact-Contract': contactEffectsContract,
            'Idempotency-Key': id,
            ...(payload.requestId && /^[A-Za-z0-9._-]{1,128}$/.test(payload.requestId)
              ? { 'X-Request-ID': payload.requestId }
              : {}),
          },
          body: JSON.stringify({ deliveryId: id, bodyHash, payload }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok)
          return response.status >= 400 &&
            response.status < 500 &&
            ![408, 429].includes(response.status)
            ? 'rejected'
            : 'uncertain';
        const ack = z.object({
          contract: z.literal(contactEffectsContract),
          deliveryId: z.literal(id),
          operationId: z.literal(payload.operationId),
          bodyHash: z.literal(bodyHash),
          status: z.literal('accepted'),
        });
        return ack.safeParse(await boundedJson(response, 64000)).success ? 'accepted' : 'uncertain';
      } catch {
        return 'uncertain';
      } finally {
        await response?.body?.cancel().catch(() => undefined);
      }
    },
  };
}
