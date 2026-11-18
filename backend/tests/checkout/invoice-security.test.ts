import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { feedbackVerifier } from '../../src/modules/checkout/feedback-proof.js';
import {
  assertInvoiceResponseProof,
  feedbackProofContract,
  invoiceSecurityContract,
  invoiceResponseProof,
} from '../../src/modules/checkout/invoice-security.js';

const invoiceKey = 'private-invoice-service-key-'.repeat(3),
  feedbackKey = 'separate-feedback-signing-key-'.repeat(3),
  customerKey = 'customer-signing-key-'.repeat(3),
  verify = feedbackVerifier({
    keys: [{ id: 'invoice-fixture-1', key: feedbackKey }],
    maxTtlSeconds: 3600,
    forbiddenKeys: [customerKey, invoiceKey],
  });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(
  payload: Record<string, unknown>,
  key = feedbackKey,
  header: Record<string, unknown> = {},
) {
  const content = `${encode({ alg: 'HS256', typ: 'JWT', kid: 'invoice-fixture-1', ...header })}.${encode(payload)}`;
  return content + '.' + createHmac('sha256', key).update(content).digest('base64url');
}
const now = Date.parse('2026-11-16T04:30:00Z'),
  issued = Math.floor(now / 1000),
  payload = {
    v: 1,
    iss: 'pos-invoice',
    aud: 'tss-pos-feedback',
    purpose: 'nps',
    type: 'nps',
    order_id: '9007199254740993',
    iat: issued,
    exp: issued + 3600,
    jti: '1'.repeat(32),
  };

describe('purpose-separated invoice and feedback contracts', () => {
  it('rejects body, nonce, order, actor and contract substitution on an otherwise valid invoice', () => {
    const scope = {
        kind: 'store' as const,
        orderId: '9007199254740993',
        operatorId: '44',
        requestId: 'invoice-request',
        nonce: 'a'.repeat(32),
      },
      html = '<table><td>Authoritative GST:18.00</td></table>',
      headers = {
        'X-POS-Invoice-Contract': invoiceSecurityContract,
        'X-POS-Feedback-Contract': feedbackProofContract,
        'X-POS-Invoice-Nonce': scope.nonce,
        'X-POS-Invoice-Proof': invoiceResponseProof(scope, html, invoiceKey),
      },
      response = new Response(html, { headers });
    expect(() => assertInvoiceResponseProof(response, scope, html, invoiceKey)).not.toThrow();
    for (const changed of [
      { ...scope, orderId: '9007199254740994' },
      { ...scope, operatorId: '45' },
      { ...scope, nonce: 'b'.repeat(32) },
      { ...scope, requestId: 'another-request' },
    ])
      expect(() => assertInvoiceResponseProof(response, changed, html, invoiceKey)).toThrow();
    expect(() => assertInvoiceResponseProof(response, scope, html + ' ', invoiceKey)).toThrow();
    expect(() =>
      assertInvoiceResponseProof(
        new Response(html, {
          headers: { ...headers, 'X-POS-Feedback-Contract': 'legacy-customer-token' },
        }),
        scope,
        html,
        invoiceKey,
      ),
    ).toThrow();
  });
  it('rejects customer signatures, wrong purpose/audience/order/TTL and unknown keys', () => {
    expect(verify(token(payload), now, payload.order_id)).toMatchObject({
      orderId: payload.order_id,
      issuedAt: issued,
      expiresAt: issued + 3600,
    });
    for (const changed of [
      { ...payload, aud: 'customer' },
      { ...payload, iss: 'customer' },
      { ...payload, purpose: 'login' },
      { ...payload, exp: issued },
      { ...payload, exp: issued + 3601 },
      { ...payload, iat: issued + 31, exp: issued + 3600 },
      { ...payload, order_id: Number(payload.order_id) },
      { ...payload, order_id: '01' },
      { ...payload, order_id: '9223372036854775808' },
      { ...payload, sub: '777' },
    ])
      expect(() => verify(token(changed), now)).toThrow('invalid or expired');
    expect(() => verify(token(payload, customerKey), now)).toThrow();
    expect(() => verify(token(payload, feedbackKey, { kid: 'unknown' }), now)).toThrow();
    expect(() => verify(token(payload, feedbackKey, { alg: 'none' }), now)).toThrow();
    expect(() => verify(token(payload), now, '9007199254740994')).toThrow();
    expect(() => verify(token(payload), now + 3600000)).toThrow();
  });
  it('retains approved feedback verification keys for rotation while refusing customer-key reuse', () => {
    const rotated = feedbackVerifier({
      keys: [
        { id: 'invoice-fixture-1', key: feedbackKey },
        { id: 'invoice-fixture-2', key: 'rotated-feedback-key-'.repeat(3) },
      ],
      maxTtlSeconds: 3600,
      forbiddenKeys: [customerKey],
    });
    expect(rotated(token(payload), now).keyId).toBe('invoice-fixture-1');
    expect(
      rotated(token(payload, 'rotated-feedback-key-'.repeat(3), { kid: 'invoice-fixture-2' }), now)
        .keyId,
    ).toBe('invoice-fixture-2');
    expect(() =>
      feedbackVerifier({
        keys: [{ id: 'invoice-fixture-1', key: customerKey }],
        maxTtlSeconds: 3600,
        forbiddenKeys: [customerKey],
      }),
    ).toThrow('configuration');
    expect(() =>
      feedbackVerifier({
        keys: [{ id: 'invoice-fixture-1', key: feedbackKey }],
        maxTtlSeconds: 3600,
        forbiddenKeys: [],
      }),
    ).toThrow('configuration');
  });
});
