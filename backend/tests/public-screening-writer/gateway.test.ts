import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import { checkoutGateway } from '../../src/modules/checkout/gateway.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import { publicScreeningOrderPayload } from '../../src/modules/checkout/screening-writer/native.js';
import { issueCustomerToken } from '../../src/modules/checkout/crypto.js';
import { signNodeScreeningWriter } from '../../src/modules/checkout/screening-writer/capability.js';
import { signingEnvironment, identity } from '../checkout/fixtures.js';
const environment = {
  ...signingEnvironment,
  customerContextContract: 'pos-customer-context-v1',
  customerContextKey: 'isolated-public-customer-key-'.repeat(3),
  screeningWriterContract: 'pos-node-screening-writer-v1' as const,
};
function prepared() {
  const now = Date.now(),
    operationId = randomUUID(),
    cart = {
      products: { items: [{ prod_id: '390238', quantity: 1, price: 50 }] },
      meta: { items: [{ name: 'calculations', total: 50, rounding_off: 0 }] },
    },
    state = checkoutStateSchema.parse({
      id: randomUUID(),
      operatorId: '1',
      operatorCustomerId: '88',
      storeId: '1',
      counterId: '2',
      tabId: 1,
      customerId: '77',
      verifiedCustomerUntil: null,
      version: 2,
      phase: 'quoted',
      cart,
      quote: cart,
      orderId: null,
      paymentConfirmation: null,
      salespersonId: null,
      lineSalespersons: {},
      giftCards: {},
      busyOperationId: operationId,
      draftId: randomUUID(),
      draftVersion: 1,
      draftImport: {
        lineItems: [{ productId: '390238', quantity: 1 }],
        completedProductIds: ['390238'],
        status: 'complete',
      },
      createdAt: now,
      updatedAt: now,
    }),
    payload = {
      is_pos: true,
      store_id: 1,
      counter_id: 2,
      admin_user_id: 88,
      payment_method: 'coc',
    },
    signed = signNodeScreeningWriter(environment, {
      state,
      operationId,
      actorVersion: 'a'.repeat(64),
      actorEpoch: '0',
      contact: { revision: '0', digest: 'b'.repeat(64) },
      payload,
      now,
    });
  return { payload, signed, token: issueCustomerToken(identity('77'), environment) };
}
describe('ordinary/public screening gateway wire boundary', () => {
  it('adds only the selected exact native payment id without mutating the ordinary payload', () => {
    const ordinary = prepared().payload;
    expect(ordinary).not.toHaveProperty('id');
    expect(publicScreeningOrderPayload(ordinary)).toMatchObject({ id: 14, payment_method: 'coc' });
    expect(ordinary).not.toHaveProperty('id');
    expect(publicScreeningOrderPayload({ ...ordinary, payment_method: 'prepaid' })).toMatchObject({
      id: 3,
    });
    expect(() => publicScreeningOrderPayload({ ...ordinary, id: 15 })).toThrow();
  });
  it('normal order bytes/headers stay unchanged; selected header is sent only to exact pos/order', async () => {
    const p = prepared(),
      calls: RequestInit[] = [],
      fetcher: typeof fetch = vi.fn(async (_url, init) => {
        calls.push(init!);
        return Response.json(
          { order: 5001, method: 14, isValid: true, name: 'placed_order' },
          {
            headers: {
              'X-POS-Customer-Context': 'pos-customer-context-v1',
              'X-POS-Customer-ID': '77',
              'X-POS-Screening-Writer-Contract': 'pos-node-screening-writer-v1',
            },
          },
        );
      }),
      gateway = checkoutGateway(
        readConfig({
          NODE_ENV: 'test',
          MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_checkout_test',
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
          SESSION_SECRET: 'isolated-public-gateway-session-key-'.repeat(3),
          TSS_API_BASE_URL: 'https://api.example.test/api/v2/',
        }),
        environment,
        fetcher,
      );
    await gateway.api('pos/order', p.payload, p.token);
    expect(new Headers(calls[0]!.headers).has('X-POS-Screening-Writer')).toBe(false);
    await gateway.api('pos/order', p.payload, p.token, { screeningWriter: p.signed.header });
    expect(calls[1]!.body).toBe(calls[0]!.body);
    expect(new Headers(calls[1]!.headers).get('X-POS-Screening-Writer')).toBe(p.signed.header);
    expect(() =>
      gateway.api('cart', p.payload, p.token, { screeningWriter: p.signed.header }),
    ).toThrow();
    expect(() =>
      gateway.api('pos/order', { ...p.payload, counter_id: 3 }, p.token, {
        screeningWriter: p.signed.header,
      }),
    ).toThrow();
    expect(() =>
      gateway.api('pos/order', p.payload, issueCustomerToken(identity('78'), environment), {
        screeningWriter: p.signed.header,
      }),
    ).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('a source 200 without the public writer marker remains uncertain, with no second dispatch', async () => {
    const p = prepared(),
      fetcher: typeof fetch = vi.fn(async () =>
        Response.json(
          { order: 5001, method: 14, isValid: true, name: 'placed_order' },
          {
            headers: {
              'X-POS-Customer-Context': 'pos-customer-context-v1',
              'X-POS-Customer-ID': '77',
            },
          },
        ),
      ),
      gateway = checkoutGateway(
        readConfig({
          NODE_ENV: 'test',
          MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_checkout_test',
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
          SESSION_SECRET: 'isolated-public-gateway-session-key-'.repeat(3),
          TSS_API_BASE_URL: 'https://api.example.test/api/v2/',
        }),
        environment,
        fetcher,
      );
    await expect(
      gateway.api('pos/order', p.payload, p.token, { screeningWriter: p.signed.header }),
    ).rejects.toMatchObject({ code: 'SCREENING_CREATION_PROOF_REQUIRED', uncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
