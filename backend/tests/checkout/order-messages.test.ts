import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  orderFeedbackLink,
  orderMessageText,
} from '../../src/modules/checkout/order-messages/policy.js';
import { localOrderMessageDelivery } from '../../src/modules/checkout/order-messages/service.js';
import { orderMessageOptions } from '../../src/modules/checkout/order-messages/options.js';
import { feedbackVerifier } from '../../src/modules/checkout/feedback-proof.js';
import { orderMessageFixtureEnvironment } from './fixtures.js';

const key = 'independent-feedback-fixture-key-0123456789',
  customerKey = 'independent-customer-fixture-key-0123456789';
describe('source-derived private order SMS policy', () => {
  it('matches30 literal pinned normal/NPS/name vectors without executing source credentials or network', () => {
    const result = spawnSync('python3', ['tools/checkout/legacy_order_sms_oracle.py'], {
      encoding: 'utf8',
      maxBuffer: 1000000,
    });
    expect(result.status, result.stderr).toBe(0);
    const vectors = z
      .array(
        z.object({
          orderId: z.string(),
          firstName: z.string(),
          lastName: z.string(),
          feedbackUrl: z.string().nullable(),
          message: z.string(),
          legacySignerCalls: z.number().int(),
          legacyMethod: z.literal('GET'),
          response: z.object({ message: z.literal('SMS Sent') }),
        }),
      )
      .parse(JSON.parse(result.stdout) as unknown);
    expect(vectors).toHaveLength(30);
    for (const value of vectors)
      expect(
        orderMessageText({
          orderId: value.orderId,
          firstName: value.firstName,
          lastName: value.lastName,
          feedbackUrl: value.feedbackUrl,
        }),
      ).toBe(value.message);
    expect(vectors.some((value) => value.legacySignerCalls === 1)).toBe(true);
  });
  it('issues only purpose feedback proof in a fragment, with exact long order IDs and bounded independent key', () => {
    const link = orderFeedbackLink({
        publicUrl: 'https://feedback.example.test/invoice-feedback',
        signing: { id: 'fixture-feedback', key },
        ttlSeconds: 600,
        forbiddenKeys: [customerKey],
      }),
      now = 1800000000000,
      url = new URL(link('9007199254740993', now)),
      proof = new URLSearchParams(url.hash.slice(1)).get('feedback_proof')!;
    expect(url.search).toBe('');
    expect(
      feedbackVerifier({
        keys: [{ id: 'fixture-feedback', key }],
        maxTtlSeconds: 600,
        forbiddenKeys: [customerKey],
      })(proof, now, '9007199254740993'),
    ).toMatchObject({ orderId: '9007199254740993', expiresAt: 1800000600 });
    const payload: unknown = JSON.parse(
      Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8'),
    );
    expect(payload).not.toHaveProperty('sub');
    expect(payload).not.toHaveProperty('telephone');
    expect(() => link('9223372036854775808', now)).toThrow();
    expect(() => link('not-an-order', now)).toThrowError(z.ZodError);
  });
  it('keeps blank/default/demo delivery disabled and rejects legacy signing-key reuse or missing contracts before HTTP', () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response('success | fixture');
    };
    expect(
      localOrderMessageDelivery({ DEMO_MODE: false }, orderMessageOptions({}), {}, fetcher),
    ).toBeUndefined();
    expect(
      localOrderMessageDelivery(
        { DEMO_MODE: true },
        orderMessageOptions(orderMessageFixtureEnvironment),
        orderMessageFixtureEnvironment,
        fetcher,
      ),
    ).toBeUndefined();
    for (const changed of [
      { POS_INVOICE_FEEDBACK_KEY: customerKey },
      { ORDER_SMS_DELIVERY_CONTRACT: 'legacy' },
      { POS_INVOICE_FEEDBACK_URL: 'https://feedback.example.test/?token=unsafe' },
      { GUPSHUP_SMS_PASSWORD: '' },
    ]) {
      const env = { ...orderMessageFixtureEnvironment, ...changed };
      expect(() =>
        localOrderMessageDelivery({ DEMO_MODE: false }, orderMessageOptions(env), env, fetcher),
      ).toThrow();
    }
    expect(calls).toBe(0);
  });
});
