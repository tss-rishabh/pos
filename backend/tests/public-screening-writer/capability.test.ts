import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import {
  nodeScreeningWriterContract,
  screeningPortableHash,
  screeningQuoteSnapshot,
  signNodeScreeningWriter,
  verifyNodeScreeningWriter,
} from '../../src/modules/checkout/screening-writer/capability.js';
const now = 1781505000000,
  operationId = '5a5d1efb-727e-45ea-b214-9136be787031',
  environment = {
    screeningWriterContract: nodeScreeningWriterContract,
    customerContextContract: 'pos-customer-context-v1',
    customerContextKey: 'isolated-node-screening-purpose-key-'.repeat(3),
  },
  cart = {
    products: {
      items: [
        { prod_id: '390238', quantity: 1, price: 50.25, gst: 2.5, stock: 20, images: ['display'] },
      ],
    },
    meta: { items: [{ name: 'calculations', total: 50, rounding_off: 0.25 }] },
  },
  state = () =>
    checkoutStateSchema.parse({
      id: '62123802-cf5f-49f1-976c-35cf1282e82b',
      operatorId: '44',
      operatorCustomerId: '88',
      storeId: '1',
      counterId: '3',
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
      draftId: '1b7c17d6-7473-4f9d-ad46-2c0ea12420f2',
      draftVersion: 12,
      draftImport: {
        lineItems: [{ productId: '390238', quantity: 1 }],
        completedProductIds: ['390238'],
        status: 'complete',
      },
      createdAt: now,
      updatedAt: now,
    }),
  input = () => ({
    state: state(),
    operationId,
    actorVersion: 'a'.repeat(64),
    actorEpoch: '9007199254740993',
    contact: { revision: '9007199254740994', digest: 'b'.repeat(64) },
    payload: { is_pos: true, store_id: 1, counter_id: 3, admin_user_id: 88, payment_method: 'coc' },
    now,
  });
function python(value: unknown): unknown {
  return JSON.parse(
    execFileSync(
      resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
      ['-B', resolve('compatibility/upstream/public-screening-writer/protocol_driver.py')],
      { input: JSON.stringify(value), encoding: 'utf8', timeout: 5000, maxBuffer: 16000 },
    ),
  ) as unknown;
}
describe('private Node POS screening writer capability', () => {
  it('binds the actual retained busy slot, actor/contact, quote and request without public payment evidence', () => {
    const value = signNodeScreeningWriter(environment, input());
    expect(verifyNodeScreeningWriter(environment, value.header, now)).toEqual(value.value);
    expect(value.value).toMatchObject({
      actorId: '44',
      customerId: '77',
      actorEpoch: '9007199254740993',
      checkoutVersion: 2,
      operationId,
      expiresAt: now + 60000,
    });
    expect(value.value).not.toHaveProperty('paid');
    expect(value.header).not.toContain(environment.customerContextKey);
    expect(
      python({ action: 'verify', key: environment.customerContextKey, now, header: value.header }),
    ).toEqual(value.value);
  });
  it('rejects absent selection, wrong purpose key, tampering and fixed expiry', () => {
    const signed = signNodeScreeningWriter(environment, input());
    expect(() =>
      signNodeScreeningWriter({ ...environment, screeningWriterContract: undefined }, input()),
    ).toThrow();
    expect(() =>
      verifyNodeScreeningWriter(
        { ...environment, customerContextKey: 'other-purpose-key-'.repeat(3) },
        signed.header,
        now,
      ),
    ).toThrow();
    expect(() =>
      verifyNodeScreeningWriter(
        environment,
        signed.header.slice(0, -1) + (signed.header.endsWith('0') ? '1' : '0'),
        now,
      ),
    ).toThrow();
    expect(() => verifyNodeScreeningWriter(environment, signed.header, now + 60000)).toThrow();
  });
  it.each(['nonce', 'phase', 'draft', 'order'] as const)(
    'refuses a stale %s before any source send',
    (kind) => {
      const value = input();
      if (kind === 'nonce') value.state.busyOperationId = crypto.randomUUID();
      if (kind === 'phase') value.state.phase = 'open';
      if (kind === 'draft') value.state.draftImport = null;
      if (kind === 'order') value.state.orderId = '5001';
      expect(() => signNodeScreeningWriter(environment, value)).toThrow();
    },
  );
  it('preserves wire numeric values, huge IDs, Unicode ordering and exact source decimal bits across Python', () => {
    const vectors = [
      { price: 50.25, integer: 1, zero: -0, decimal: 0.1, id: '9007199254740993' },
      { '\uE000': 1, '😀': 2, text: 'अ\u2028\u2029', nested: [null, true, 2.675, 1e-10] },
      { uint: '18446744073709551615', quote: screeningQuoteSnapshot(cart) },
    ];
    for (const value of vectors)
      expect(python({ action: 'hash', value })).toEqual({ hash: screeningPortableHash(value) });
    expect(screeningPortableHash({ id: 9007199254740993n })).toBe(
      screeningPortableHash({ id: '9007199254740993' }),
    );
    expect(() => screeningPortableHash({ price: Infinity })).toThrow();
    expect(() => screeningPortableHash({ id: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => screeningPortableHash({ text: '\ud800' })).toThrow();
  });
  it('ignores only known display/transient fields and detects financial/selection changes', () => {
    const displayed = structuredClone(cart);
    displayed.products.items[0]!.stock = 7;
    displayed.products.items[0]!.images = ['new display'];
    expect(screeningPortableHash(screeningQuoteSnapshot(displayed))).toBe(
      screeningPortableHash(screeningQuoteSnapshot(cart)),
    );
    displayed.products.items[0]!.price = 50.24;
    expect(screeningPortableHash(screeningQuoteSnapshot(displayed))).not.toBe(
      screeningPortableHash(screeningQuoteSnapshot(cart)),
    );
  });
});
