import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { feedbackVerifier, type FeedbackVerificationKey } from '../feedback-proof.js';

export const orderMessageIdentifier = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((id) => /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n);
/** Literal OmniChannelSms text: source concatenates first and last names without adding a separator. */
export function orderMessageText(input: {
  orderId: string;
  firstName: string;
  lastName: string;
  feedbackUrl: string | null;
}) {
  const value = z
    .object({
      orderId: orderMessageIdentifier,
      firstName: z.string().max(256),
      lastName: z.string().max(256),
      feedbackUrl: z.string().max(4096).nullable(),
    })
    .strict()
    .parse(input);
  const name = value.firstName + value.lastName;
  return value.feedbackUrl
    ? `Hey ${name}! Thank you for placing your order with The Souled Store. We’d love to know your shopping experience here: ${value.feedbackUrl}`
    : `Hey ${name}! Your order (ID: ${value.orderId}) has been placed & the details have been mailed to you. Thank you for shopping with a homegrown Indian brand.`;
}
export function orderFeedbackLink(configuration: {
  publicUrl: string;
  signing: FeedbackVerificationKey;
  ttlSeconds: number;
  forbiddenKeys: readonly string[];
}) {
  const url = new URL(configuration.publicUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.length > 1024
  )
    throw new Error('Order feedback delivery configuration is invalid.');
  const verify = feedbackVerifier({
    keys: [configuration.signing],
    maxTtlSeconds: configuration.ttlSeconds,
    forbiddenKeys: configuration.forbiddenKeys,
  });
  return (id: string, now = Date.now()) => {
    orderMessageIdentifier.parse(id);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Order feedback time is invalid.');
    const issuedAt = Math.floor(now / 1000),
      header = Buffer.from(
        JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: configuration.signing.id }),
      ).toString('base64url'),
      payload = Buffer.from(
        JSON.stringify({
          v: 1,
          iss: 'pos-invoice',
          aud: 'tss-pos-feedback',
          purpose: 'nps',
          type: 'nps',
          order_id: id,
          iat: issuedAt,
          exp: issuedAt + configuration.ttlSeconds,
          jti: randomBytes(16).toString('hex'),
        }),
      ).toString('base64url'),
      message = `${header}.${payload}`,
      proof = `${message}.${createHmac('sha256', configuration.signing.key).update(message).digest('base64url')}`;
    verify(proof, now, id);
    const result = new URL(url);
    result.hash = `feedback_proof=${proof}`;
    return result.href;
  };
}
