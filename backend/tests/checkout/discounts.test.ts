import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  approverSelection,
  discountMetadataSchema,
  discountPolicy,
  discountTerms,
} from '../../src/modules/checkout/discounts/policy.js';
import {
  approvalCode,
  codeDigest,
  decryptCode,
  encryptCode,
  matchesCode,
} from '../../src/modules/checkout/discounts/crypto.js';
import { assertDiscountDeliveryReady } from '../../src/modules/checkout/discounts/delivery.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';

const secret = 'isolated-discount-approval-secret-'.repeat(3);
const state = () =>
  checkoutStateSchema.parse({
    id: crypto.randomUUID(),
    operatorId: '44',
    operatorCustomerId: '777',
    storeId: '1',
    counterId: '3',
    tabId: 1,
    customerId: null,
    verifiedCustomerUntil: null,
    version: 1,
    phase: 'quoted',
    cart: null,
    quote: {
      products: { items: [{ prod_id: 10, quantity: 1, amount: 80 }] },
      meta: {
        items: [
          {
            name: 'calculations',
            products_total: 80,
            total: 80,
            used_pg_discount: 0,
            used_store_discount_pg: 20,
          },
        ],
      },
    },
    orderId: null,
    paymentConfirmation: null,
    salespersonId: null,
    lineSalespersons: {},
    giftCards: {},
    discountMetadata: {
      pg: null,
      store: { remark: 'Price issue', reason: 'Price mismatch (Online v/s POS)' },
    },
    busyOperationId: null,
    createdAt: 0,
    updatedAt: 0,
  });
describe('manager discount approval source contract and security bindings', () => {
  it('matches original Python threshold selection including fallback, exemption and exact boundaries', () => {
    const thresholds = {
      '1': {
        '0': ['base@example.test'],
        '10': ['ten@example.test'],
        '20': ['twenty@example.test'],
        '50': [],
      },
    };
    const cases = [
      ...['0', '1', '9.99', '10', '19.99', '20', '49.99', '50', '80', '100'].flatMap((value) =>
        [true, false].map((sendAll) => ({
          storeId: '1',
          amount: value,
          productsTotal: String(100 - Number(value)),
          thresholds,
          sendAll,
        })),
      ),
      { storeId: '2', amount: '10', productsTotal: '90', thresholds, sendAll: true },
      { storeId: '2', amount: '10', productsTotal: '90', thresholds, sendAll: false },
    ];
    const expected: unknown = JSON.parse(
      execFileSync('python3', ['tools/checkout/legacy_oracle.py'], {
        input: JSON.stringify({ operation: 'discount_policy', cases }),
        encoding: 'utf8',
      }),
    );
    expect(
      cases.map((item) =>
        approverSelection(
          {
            ...discountPolicy({}),
            storeThresholds: item.thresholds,
            sendToAllManagers: item.sendAll,
          },
          item.storeId,
          item,
        ),
      ),
    ).toEqual(expected);
    expect(discountPolicy({})).toMatchObject({
      permittedRoles: [1, 2, 3, 4],
      exemptRoles: [1, 2, 3],
      expirySeconds: 600,
    });
  });
  it('binds the exact server financial terms, customer, quantities, metadata and checkout identity', () => {
    const original = state(),
      terms = discountTerms(original, secret);
    expect(terms).toMatchObject({
      amount: '20.00',
      pgAmount: '0.00',
      storeAmount: '20.00',
      productsTotal: '80.00',
      comment: '|Price issue',
    });
    for (const change of [
      { customerId: '1001' },
      { id: crypto.randomUUID() },
      { counterId: '4' },
      {
        discountMetadata: {
          pg: null,
          store: { remark: 'Different issue', reason: 'Price mismatch (Online v/s POS)' as const },
        },
      },
      {
        quote: {
          ...original.quote,
          products: { items: [{ prod_id: 10, quantity: 2, amount: 80 }] },
        },
      },
      {
        quote: {
          ...original.quote,
          meta: {
            items: [
              { name: 'calculations', products_total: 80, total: 79, used_store_discount_pg: 20 },
            ],
          },
        },
      },
    ])
      expect(discountTerms({ ...original, ...change }, secret).binding).not.toBe(terms.binding);
    expect(() =>
      discountTerms({ ...original, discountMetadata: { pg: null, store: null } }, secret),
    ).toThrow('Save a remark');
    expect(() =>
      discountTerms(
        {
          ...original,
          quote: {
            products: { items: [] },
            meta: { items: [{ name: 'calculations', used_store_discount_pg: 20 }] },
          },
        },
        secret,
      ),
    ).toThrow('missing its products total');
    expect(discountMetadataSchema.safeParse({ pg: { remark: '...' }, store: null }).success).toBe(
      false,
    );
  });
  it('stores manager codes as hashes and authenticated ciphertext bound to the delivery identity', () => {
    const id = crypto.randomUUID(),
      manager = '45',
      code = approvalCode(),
      digest = codeDigest(secret, id, manager, code),
      sealed = encryptCode(secret, id, code);
    expect(code).toMatch(/^[1-9]{6}$/);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(sealed).not.toContain(code);
    expect(decryptCode(secret, id, sealed)).toBe(code);
    expect(matchesCode(secret, id, manager, code, digest)).toBe(true);
    expect(matchesCode(secret, crypto.randomUUID(), manager, code, digest)).toBe(false);
    expect(matchesCode(secret, id, '46', code, digest)).toBe(false);
    expect(() => decryptCode(secret, crypto.randomUUID(), sealed)).toThrow();
    expect(() => encryptCode('short', id, code)).toThrow('not configured');
  });
  it('fails closed for missing or insecure approval delivery configuration', () => {
    for (const environment of [
      {},
      { url: 'http://mail.example.test', apiKey: 'fixture', approvalSecret: secret },
      { url: 'https://user:pass@mail.example.test', apiKey: 'fixture', approvalSecret: secret },
      {
        url: 'https://mail.example.test/?api_key=secret',
        apiKey: 'fixture',
        approvalSecret: secret,
      },
    ])
      expect(() => assertDiscountDeliveryReady(environment)).toThrow();
    expect(() =>
      assertDiscountDeliveryReady({
        url: 'https://mail.example.test/send',
        apiKey: 'fixture',
        approvalSecret: secret,
      }),
    ).not.toThrow();
  });
});
