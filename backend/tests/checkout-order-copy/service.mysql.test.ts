import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import {
  checkoutStateSchema,
  type Cart,
  type CheckoutState,
} from '../../src/modules/checkout/contracts.js';
import type { CopyCartPort } from '../../src/modules/checkout/order-copy/contracts.js';
import { cartCopyHash } from '../../src/modules/checkout/order-copy/domain.js';
import { orderCopyService } from '../../src/modules/checkout/order-copy/service.js';
import { checkoutSessionStore } from '../../src/modules/checkout/session-store.js';
import { memoryStateStore } from '../../src/modules/checkout/state-store.js';
import { orderCopyFixture } from './mysql-fixture.js';
import { z } from 'zod';
import { goldenStdout } from '../golden/load.js';

/**
 * Messages of the pinned AjaxCopyOrderView handler vectors (order/views.py; backend-pos-web
 * 78d5b63), replayed from tests/golden/checkout-order-copy/source.json. The rewrite keeps the
 * legacy texts; its HTTP statuses (404/409 instead of a 204 body status) are the approved
 * status policy, and the legacy defects that source.test.ts pins (whole-cart concatenation,
 * a thrown addition reported as "Cart Synced") are not reproduced.
 */
const legacyVectors = z
  .record(z.string(), z.object({ status: z.number(), message: z.string() }).passthrough())
  .parse(JSON.parse(goldenStdout('checkout-order-copy', 'source')) as unknown);

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const operator: Principal = {
  id: '44',
  name: 'Cashier',
  email: 'cashier@example.test',
  role: 3,
  userType: 1,
  storeIds: ['1'],
};

describe.skipIf(!template)('legacy order copy into the connected customer cart', () => {
  let fixture: Awaited<ReturnType<typeof orderCopyFixture>>;
  beforeAll(async () => {
    fixture = await orderCopyFixture(template!);
    const insert = fixture.fixture.insert;
    await insert('orders', { id: 900, user_id: 501 });
    await insert('order_stores', { id: 1, order_id: 900, store_id: 2 });
    await insert('has_products', { id: 9001, order_id: 900, prod_id: 10, qty: 4 });
    await insert('has_products', { id: 9002, order_id: 900, prod_id: 10, qty: 1 });
    await insert('has_products', { id: 9003, order_id: 900, prod_id: 12, qty: 1 });
    await insert('orders', { id: 901, user_id: 777 });
    await insert('order_stores', { id: 2, order_id: 901, store_id: 9 });
    await insert('has_products', { id: 9101, order_id: 901, prod_id: 10, qty: 1 });
  });
  afterAll(async () => {
    await fixture?.close();
  });
  function setup(failOn?: string) {
    const stateStore = memoryStateStore(),
      sessions = checkoutSessionStore(stateStore),
      secret = fixture.config.SESSION_SECRET,
      checkoutId = crypto.randomUUID(),
      sends: { productId: string; quantity: number }[] = [];
    let cart: Cart = { products: { items: [{ prod_id: 10, quantity: 1, price: 100 }] } };
    const port: CopyCartPort = {
      read: async () => structuredClone(cart),
      async setLine(state, _stepId, productId, quantity, expectedHash) {
        if (!state.busyOperationId || state.orderCopy?.commandId !== state.busyOperationId)
          throw new AppError(409, 'ORDER_COPY_NOT_RESERVED', 'Not reserved.');
        if (cartCopyHash(cart, secret) !== expectedHash)
          throw new AppError(409, 'ORDER_COPY_BASE_CART_CHANGED', 'Changed.');
        if (productId === failOn) throw new AppError(422, 'PRODUCT_BARCODE_MISSING', 'No barcode.');
        sends.push({ productId, quantity });
        const items = cart.products.items.filter((item) => String(item.prod_id) !== productId);
        cart = { products: { items: [...items, { prod_id: Number(productId), quantity }] } };
        return { ...state, cart };
      },
    };
    const state: CheckoutState = checkoutStateSchema.parse({
      id: checkoutId,
      operatorId: '44',
      operatorCustomerId: '88',
      storeId: '1',
      counterId: '3',
      tabId: 1,
      customerId: '501',
      verifiedCustomerUntil: null,
      version: 4,
      phase: 'quoted',
      cart,
      quote: { total: 1 },
      orderId: null,
      orderSubmissionOperationId: null,
      paymentConfirmation: null,
      salespersonId: null,
      lineSalespersons: {},
      giftCards: {},
      busyOperationId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return {
      sessions,
      sends,
      state,
      scope: { storeId: '1', checkoutId },
      service: orderCopyService(fixture.config, fixture.db, sessions, port),
      cart: () => cart,
    };
  }

  it('adds one unit per original line in order and leaves no reservation behind', async () => {
    const { sessions, sends, state, scope, service } = setup();
    await sessions.write(state);
    await sessions.acquireLease('customer', '501', state.id);
    expect(await service.copy(operator, scope, { orderId: '900' })).toEqual({
      orderId: '900',
      partial: false,
      message: legacyVectors.normal!.message,
    });
    expect(sends).toEqual([
      { productId: '10', quantity: 2 },
      { productId: '10', quantity: 3 },
      { productId: '12', quantity: 1 },
    ]);
    const saved = (await sessions.read(state.id))!;
    expect(saved).toMatchObject({
      busyOperationId: null,
      orderCopy: null,
      quote: null,
      phase: 'open',
      version: 5,
    });
  });

  it('stops at the first failed addition and reports the legacy partial message', async () => {
    const { sessions, sends, state, scope, service } = setup('12');
    await sessions.write(state);
    await sessions.acquireLease('customer', '501', state.id);
    expect(await service.copy(operator, scope, { orderId: '900' })).toMatchObject({
      partial: true,
      message: legacyVectors['partial-none']!.message,
    });
    expect(sends).toHaveLength(2);
  });

  it('requires a connected customer, its cart lease and an order the operator may read', async () => {
    const { sessions, sends, state, scope, service } = setup();
    await sessions.write({ ...state, customerId: null });
    await expect(service.copy(operator, scope, { orderId: '900' })).rejects.toMatchObject({
      status: 409,
      message: legacyVectors.disconnected!.message,
    });
    await sessions.write(state);
    await expect(service.copy(operator, scope, { orderId: '900' })).rejects.toMatchObject({
      code: 'ORDER_COPY_CUSTOMER_LEASE_REQUIRED',
    });
    await sessions.acquireLease('customer', '501', state.id);
    for (const orderId of ['901', '999'])
      await expect(service.copy(operator, scope, { orderId })).rejects.toMatchObject({
        status: 404,
        message: legacyVectors.missing!.message,
      });
    expect(sends).toEqual([]);
  });
});
