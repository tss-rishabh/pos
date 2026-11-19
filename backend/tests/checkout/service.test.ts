import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/domain/errors.js';
import { checkoutService, publicState } from '../../src/modules/checkout/service.js';
import { CheckoutGatewayError } from '../../src/modules/checkout/gateway.js';
import {
  MemoryCheckoutRepository,
  FixtureGateway,
  operator,
  signingEnvironment,
} from './fixtures.js';

let repository: MemoryCheckoutRepository,
  gateway: FixtureGateway,
  service: ReturnType<typeof checkoutService>,
  clock: number;
beforeEach(() => {
  repository = new MemoryCheckoutRepository();
  gateway = new FixtureGateway();
  clock = Date.now();
  service = checkoutService(repository, gateway, signingEnvironment, {
    migrationV2: true,
    now: () => clock,
    assertCheckIn: async (user, store, counter) => {
      if (user !== '44' || store !== '1' || (counter && counter !== '3'))
        throw new AppError(409, 'CHECK_IN_REQUIRED', 'Check in first.');
    },
    finalizeOrder: async () => ({ transactionId: 'TXN-5001', invoice: 'S012627INV00001' }),
  });
});
const mutation = (version: number) => ({
  operationId: crypto.randomUUID(),
  expectedVersion: version,
});
/** Legacy blocks an empty cart and a missing salesperson before AjaxOrderView. */
function readyToOrder(id: string) {
  const state = repository.states.get(id)!;
  state.salespersonId = '5';
  gateway.carts.set(`777:${state.tabId}`, {
    ...gateway.empty(),
    products: { items: [{ prod_id: 10, quantity: 1, prod_type: 1 }] },
  });
}
describe('checkout workflow authorization and external-effect safety', () => {
  it('keeps the payment note private, versioned, amount-bound and replay-safe before order dispatch', async () => {
    const created = await service.create(operator, '1', '3');
    await service.quote(operator, '1', created.id, mutation(0));
    const input = mutation(1),
      message = '#Cash Received:100\nDesk café';
    const reply = await service.settlementNote(operator, '1', created.id, input, message, '100');
    const visible = publicState(reply.state);
    expect(visible.settlementNote).toMatchObject({ payable: '99.00', cashReceived: '100.00' });
    expect(visible.settlementNote).not.toHaveProperty('message');
    expect(JSON.stringify(visible)).not.toContain('Desk café');
    expect(await service.readSettlementNote(operator, '1', created.id)).toMatchObject({ message });
    const replay = await service.settlementNote(operator, '1', created.id, input, message, '100');
    expect(replay.state.version).toBe(reply.state.version);
    await expect(
      service.settlementNote(operator, '1', created.id, input, 'changed', '100'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      service.settlementNote(operator, '1', created.id, mutation(reply.state.version), '😀', '100'),
    ).rejects.toThrow();
    await expect(
      service.settlementNote(
        operator,
        '1',
        created.id,
        mutation(reply.state.version),
        message,
        '1',
      ),
    ).rejects.toMatchObject({ code: 'CASH_NOTE_AMOUNT_INVALID' });
    expect(gateway.calls.some((call) => call.path === 'pos/order')).toBe(false);
    await expect(
      service.readSettlementNote({ ...operator, id: '45' }, '1', created.id),
    ).rejects.toMatchObject({
      code: 'CHECKOUT_NOT_FOUND',
    });
  });
  it('rejects salesperson IDs outside the physical order INT range without querying or dispatching', async () => {
    const created = await service.create(operator, '1', '3');
    const spy = vi.spyOn(repository, 'salesperson');
    await expect(
      service.salesperson(operator, '1', created.id, mutation(0), '2147483648'),
    ).rejects.toMatchObject({ code: 'SALESPERSON_ID_INVALID' });
    expect(spy).not.toHaveBeenCalled();
    expect(gateway.calls).toHaveLength(0);
  });
  it('saves master and per-product assignments separately with the original quote intact', async () => {
    const created = await service.create(operator, '1', '3');
    await service.setLine(operator, '1', created.id, mutation(0), '10', 1);
    await service.quote(operator, '1', created.id, mutation(1));
    const quoted = repository.states.get(created.id)!.quote;
    const master = await service.salesperson(operator, '1', created.id, mutation(2), '5');
    expect(master.state).toMatchObject({ salespersonId: '5', phase: 'quoted', quote: quoted });
    const line = await service.salesperson(operator, '1', created.id, mutation(3), '5', '10');
    expect(line.state).toMatchObject({
      salespersonId: '5',
      lineSalespersons: { '10': '5' },
      phase: 'quoted',
      quote: quoted,
    });
    await expect(
      service.salesperson(operator, '1', created.id, mutation(4), '6'),
    ).rejects.toMatchObject({ code: 'SALESPERSON_NOT_ASSIGNED' });
    await expect(
      service.salesperson(operator, '1', created.id, mutation(4), '5', '999'),
    ).rejects.toMatchObject({ code: 'SALESPERSON_PRODUCT_UNAVAILABLE' });
  });
  it('does not re-verify an applied employee coupon at order time, as legacy AjaxOrderView', async () => {
    const created = await service.create(operator, '1', '3');
    await service.attachCustomer(operator, '1', created.id, mutation(0), '1001');
    gateway.intercept = async (path) =>
      path === 'processorder'
        ? {
            ...gateway.empty(),
            products: { items: [{ prod_id: 10, quantity: 1, prod_type: 1 }] },
            meta: {
              items: [
                { name: 'calculations', total: 99 },
                { name: 'coupon', coupon: 'EMPLOYEE' },
              ],
            },
          }
        : undefined;
    repository.states.get(created.id)!.salespersonId = '5';
    await service.quote(operator, '1', created.id, mutation(1));
    expect((await service.submit(operator, '1', created.id, mutation(2))).status).toBe('succeeded');
    expect(gateway.calls.filter((call) => call.path === 'pos/order')).toHaveLength(1);
  });
  it('keeps a complementary-product salesperson override distinct from the sale default', async () => {
    const created = await service.create(operator, '1', '3');
    const saved = repository.states.get(created.id)!;
    saved.cart = {
      products: { items: [] },
      complementary_products: { items: [{ prod_id: '11', quantity: 1 }] },
    };
    const assigned = await service.salesperson(operator, '1', created.id, mutation(0), '5', '11');
    expect(assigned.state.lineSalespersons).toEqual({ '11': '5' });
    expect(assigned.state.salespersonId).toBeNull();
    expect(gateway.calls).toHaveLength(0);
  });
  it('blocks the order with the legacy salesperson and empty-cart messages before pos/order', async () => {
    const created = await service.create(operator, '1', '3');
    await service.quote(operator, '1', created.id, mutation(0));
    await expect(service.submit(operator, '1', created.id, mutation(1))).rejects.toMatchObject({
      code: 'CART_EMPTY',
      message: 'Please add some product into the cart.',
    });
    const other = await service.create(operator, '1', '3');
    readyToOrder(other.id);
    repository.states.get(other.id)!.salespersonId = null;
    await service.quote(operator, '1', other.id, mutation(0));
    await expect(service.submit(operator, '1', other.id, mutation(1))).rejects.toMatchObject({
      code: 'SALESPERSON_REQUIRED',
      message: 'Please Select The Salesperson.',
    });
    expect(gateway.calls.some((call) => call.path === 'pos/order')).toBe(false);
  });
  it('lets the cashier retry after a non-200 pos/order, as legacy "Something Went Wrong"', async () => {
    const state = await service.create(operator, '1', '3');
    readyToOrder(state.id);
    await service.quote(operator, '1', state.id, mutation(0));
    gateway.intercept = async (path) => {
      if (path === 'pos/order')
        throw new CheckoutGatewayError(
          'ORDER_CREATE_FAILED',
          'Something Went Wrong. The order was not created; try again.',
          false,
        );
      return undefined;
    };
    await expect(service.submit(operator, '1', state.id, mutation(1))).rejects.toMatchObject({
      code: 'ORDER_CREATE_FAILED',
    });
    expect(repository.states.get(state.id)).toMatchObject({ phase: 'quoted', orderId: null });
    gateway.intercept = undefined;
    expect((await service.submit(operator, '1', state.id, mutation(1))).status).toBe('succeeded');
    expect(gateway.calls.filter((call) => call.path === 'pos/order')).toHaveLength(2);
  });
  it.each(['clear', 'detachCustomer'] as const)(
    'clears both customer and actor carts and detaches the account through %s',
    async (action) => {
      const created = await service.create(operator, '1', '3');
      await service.setLine(operator, '1', created.id, mutation(0), '10', 2);
      await service.attachCustomer(operator, '1', created.id, mutation(1), '1001');
      const saved = repository.states.get(created.id)!;
      saved.salespersonId = '5';
      saved.lineSalespersons = { '10': '5' };
      saved.verifiedCustomerUntil = clock + 10000;
      saved.discountMetadata = { pg: null, store: null };
      const input = mutation(2),
        done = await service[action](operator, '1', created.id, input);
      expect(done.status).toBe('succeeded');
      expect(done.state).toMatchObject({
        customerId: null,
        verifiedCustomerUntil: null,
        verificationChallenge: null,
        salespersonId: null,
        lineSalespersons: {},
        giftCards: {},
        giftCardDates: {},
        giftCardValues: {},
        cart: { products: { items: [] } },
      });
      expect(repository.customerLeases.has('1001')).toBe(false);
      const before = gateway.calls.length;
      expect((await service[action](operator, '1', created.id, input)).status).toBe('succeeded');
      expect(gateway.calls).toHaveLength(before);
      expect([...gateway.carts.values()].every((cart) => cart.products.items.length === 0)).toBe(
        true,
      );
    },
  );
  it('freezes an uncertain detach without releasing the customer or overwriting its confirmed clear checkpoint', async () => {
    const created = await service.create(operator, '1', '3');
    await service.setLine(operator, '1', created.id, mutation(0), '10', 1);
    await service.attachCustomer(operator, '1', created.id, mutation(1), '1001');
    gateway.intercept = async (path, payload) => {
      const value = payload.payload;
      if (
        path === 'cart' &&
        payload.tab_id &&
        typeof value === 'object' &&
        value !== null &&
        'operation' in value &&
        value.operation === 'clear'
      )
        throw new CheckoutGatewayError(
          'CHECKOUT_OUTCOME_UNCERTAIN',
          'Fixture lost clear result',
          true,
        );
      return undefined;
    };
    const input = mutation(2);
    await expect(service.detachCustomer(operator, '1', created.id, input)).rejects.toMatchObject({
      code: 'CHECKOUT_OUTCOME_UNCERTAIN',
    });
    expect(await service.read(operator, '1', created.id)).toMatchObject({
      phase: 'uncertain',
      customerId: '1001',
      cart: { products: { items: [] } },
    });
    expect(repository.customerLeases.get('1001')).toBe(created.id);
    const before = gateway.calls.length;
    expect((await service.detachCustomer(operator, '1', created.id, input)).status).toBe(
      'uncertain',
    );
    expect(gateway.calls).toHaveLength(before);
  });
  it('keeps message preferences server-owned and does not allow modifying them after order creation', async () => {
    const created = await service.create(operator, '1', '3');
    // Legacy always posts nps_feedback_switch=true (create_order.html:76, :5646).
    expect(created.orderNotifications).toEqual({ sendSms: true, npsFeedback: true });
    readyToOrder(created.id);
    const changed = await service.orderNotifications(operator, '1', created.id, mutation(0), {
      sendSms: true,
      npsFeedback: true,
    });
    expect(changed.state.orderNotifications?.npsFeedback).toBe(true);
    await service.quote(operator, '1', created.id, mutation(1));
    await service.submit(operator, '1', created.id, mutation(2));
    await expect(
      service.orderNotifications(operator, '1', created.id, mutation(3), {
        sendSms: false,
        npsFeedback: false,
      }),
    ).rejects.toMatchObject({ code: 'CHECKOUT_ALREADY_SUBMITTED' });
  });
  it('blocks quoting a partial saved sale, resumes only missing lines, and retains later explicit edits', async () => {
    const draftId = crypto.randomUUID(),
      draft = {
        version: clock,
        lineItems: [
          { productId: '10', quantity: 2 },
          { productId: '11', quantity: 1 },
        ],
      },
      created = await service.create(operator, '1', '3', draftId, draft);
    gateway.intercept = async (path, payload) => {
      if (path === 'pos/product' && payload.barcode === '8900000000011')
        throw new AppError(422, 'FIXTURE_UNAVAILABLE', 'Fixture product unavailable');
      return undefined;
    };
    await expect(
      service.initializeDraft(operator, '1', created.id, mutation(0)),
    ).rejects.toMatchObject({ code: 'FIXTURE_UNAVAILABLE' });
    const saved = await service.read(operator, '1', created.id);
    expect(saved.draftImport).toMatchObject({ status: 'pending', completedProductIds: ['10'] });
    await expect(service.quote(operator, '1', created.id, mutation(0))).rejects.toMatchObject({
      code: 'CHECKOUT_DRAFT_NOT_INITIALIZED',
    });
    await expect(
      service.setLine(operator, '1', created.id, mutation(0), '10', 9),
    ).rejects.toMatchObject({ code: 'CHECKOUT_DRAFT_NOT_INITIALIZED' });
    await expect(service.submit(operator, '1', created.id, mutation(0))).rejects.toMatchObject({
      code: 'CHECKOUT_DRAFT_NOT_INITIALIZED',
    });
    gateway.intercept = undefined;
    const completed = await service.initializeDraft(operator, '1', created.id, mutation(0));
    expect(completed.state.draftImport?.status).toBe('complete');
    expect(
      gateway.calls.filter(
        (call) => call.path === 'pos/product' && call.payload.barcode === '8900000000010',
      ),
    ).toHaveLength(1);
    await service.setLine(operator, '1', created.id, mutation(1), '10', 3);
    const restored = await service.create(operator, '1', '3', draftId, draft);
    expect(restored.cart?.products.items.find((item) => item.prod_id === 10)?.quantity).toBe(3);
    expect(restored.draftImport?.status).toBe('complete');
    const replay = await service.initializeDraft(operator, '1', created.id, mutation(2));
    expect(replay.state.cart?.products.items.find((item) => item.prod_id === 10)?.quantity).toBe(3);
    await expect(
      service.create(operator, '1', '3', draftId, { ...draft, version: clock + 1 }),
    ).rejects.toMatchObject({ code: 'CHECKOUT_DRAFT_CONTENT_CONFLICT' });
  });
  it('freezes an interrupted saved-line import with an unknown upstream outcome instead of replaying additions', async () => {
    const created = await service.create(operator, '1', '3', crypto.randomUUID(), {
      version: clock,
      lineItems: [
        { productId: '10', quantity: 1 },
        { productId: '11', quantity: 1 },
      ],
    });
    gateway.intercept = async (path, payload) => {
      if (path === 'pos/product' && payload.barcode === '8900000000011')
        throw new CheckoutGatewayError(
          'CHECKOUT_OUTCOME_UNCERTAIN',
          'Fixture unknown outcome',
          true,
        );
      return undefined;
    };
    const input = mutation(0);
    await expect(service.initializeDraft(operator, '1', created.id, input)).rejects.toMatchObject({
      code: 'CHECKOUT_OUTCOME_UNCERTAIN',
    });
    expect((await service.initializeDraft(operator, '1', created.id, input)).status).toBe(
      'uncertain',
    );
    await expect(
      service.initializeDraft(operator, '1', created.id, mutation(0)),
    ).rejects.toMatchObject({ code: 'CHECKOUT_REVIEW_REQUIRED' });
    expect(gateway.calls.filter((call) => call.path === 'pos/product')).toHaveLength(2);
    expect(
      (await service.read(operator, '1', created.id)).draftImport?.completedProductIds,
    ).toEqual(['10']);
  });
  it('reuses the latest checkout for one saved draft without resetting its authoritative cart', async () => {
    const draftId = crypto.randomUUID(),
      initial = await service.create(operator, '1', '3', draftId);
    expect((await service.create(operator, '1', '3', draftId)).id).toBe(initial.id);
    await service.setLine(operator, '1', initial.id, mutation(0), '10', 3);
    const restored = await service.create(operator, '1', '3', draftId);
    expect(restored).toMatchObject({ id: initial.id, draftId, version: 1 });
    expect(restored.cart?.products.items[0]?.quantity).toBe(3);
    expect(gateway.calls.filter((call) => call.path === 'pos/product')).toHaveLength(1);
    expect((await service.create(operator, '1', '3', crypto.randomUUID())).id).not.toBe(initial.id);
  });
  it('requires assignment, active counter and persisted check-in before creating a checkout', async () => {
    await expect(service.create(operator, '99', '3')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await expect(service.create(operator, '1', '999')).rejects.toMatchObject({
      code: 'CHECK_IN_REQUIRED',
    });
    const created = await service.create(operator, '1', '3');
    expect(created.version).toBe(0);
    expect(created).not.toHaveProperty('operatorCustomerId');
  });
  it('does not repeat an external cart mutation while its operation is inflight or after success', async () => {
    const state = await service.create(operator, '1', '3'),
      input = mutation(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gateway.intercept = async (path) => {
      if (path === 'pos/product') await gate;
      return undefined;
    };
    const first = service.setLine(operator, '1', state.id, input, '10', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const concurrent = await service.setLine(operator, '1', state.id, input, '10', 1);
    expect(concurrent.status).toBe('inflight');
    release();
    const complete = await first;
    expect(complete.status).toBe('succeeded');
    expect((await service.setLine(operator, '1', state.id, input, '10', 1)).status).toBe(
      'succeeded',
    );
    expect(gateway.calls.filter((c) => c.path === 'pos/product')).toHaveLength(1);
    await expect(service.setLine(operator, '1', state.id, input, '10', 2)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('binds customer verification on the server and expires wallet authority', async () => {
    const created = await service.create(operator, '1', '3');
    const attached = await service.attachCustomer(operator, '1', created.id, mutation(0), '1001');
    expect(attached.status).toBe('succeeded');
    await expect(
      service.wallet(operator, '1', created.id, mutation(1), {
        money: true,
        points: false,
        appliedMoney: '1.00',
        custom: true,
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_REQUIRED' });
    await service.sendVerification(operator, '1', created.id, mutation(1));
    await expect(
      service.verify(operator, '1', created.id, mutation(2), '000000'),
    ).rejects.toMatchObject({ code: 'OTP_INVALID' });
    const verified = await service.verify(operator, '1', created.id, mutation(2), '123456');
    expect(verified.status).toBe('succeeded');
    const applied = await service.wallet(operator, '1', created.id, mutation(3), {
      money: true,
      points: false,
      appliedMoney: '1.00',
      custom: true,
    });
    expect(applied.status).toBe('succeeded');
    clock += 16 * 60000;
    await expect(
      service.wallet(operator, '1', created.id, mutation(4), {
        money: true,
        points: false,
        appliedMoney: '1.00',
        custom: true,
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_REQUIRED' });
  });
  it('serializes customer-global upstream carts across separate POS sessions', async () => {
    const first = await service.create(operator, '1', '3'),
      second = await service.create(operator, '1', '3');
    await service.attachCustomer(operator, '1', first.id, mutation(0), '1001');
    await expect(
      service.attachCustomer(operator, '1', second.id, mutation(0), '1001'),
    ).rejects.toMatchObject({ code: 'CUSTOMER_CART_BUSY' });
    expect(gateway.calls.filter((c) => c.path === 'syncart')).toHaveLength(1);
  });
  it('requires a bound live challenge and persists unsuccessful OTP attempts across operation keys', async () => {
    const created = await service.create(operator, '1', '3');
    await service.attachCustomer(operator, '1', created.id, mutation(0), '1001');
    await expect(
      service.verify(operator, '1', created.id, mutation(1), '123456'),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_CHALLENGE_REQUIRED' });
    await service.sendVerification(operator, '1', created.id, mutation(1));
    await expect(
      service.sendVerification(operator, '1', created.id, mutation(2)),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SEND_LIMIT' });
    for (let index = 0; index < 5; index++)
      await expect(
        service.verify(operator, '1', created.id, mutation(2), '000000'),
      ).rejects.toMatchObject({ code: 'OTP_INVALID' });
    await expect(
      service.verify(operator, '1', created.id, mutation(2), '123456'),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_ATTEMPT_LIMIT' });
    expect(gateway.calls.filter((call) => call.path === 'omnichannel-verifyotp')).toHaveLength(5);
    clock += 61000;
    await service.sendVerification(operator, '1', created.id, mutation(2));
    clock += 5 * 60000;
    await expect(
      service.verify(operator, '1', created.id, mutation(3), '123456'),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_CHALLENGE_REQUIRED' });
  });
  it('does not synchronize and clear a customer cart when that customer is attached again', async () => {
    const created = await service.create(operator, '1', '3');
    await service.attachCustomer(operator, '1', created.id, mutation(0), '1001');
    const before = gateway.calls.length;
    expect(
      (await service.attachCustomer(operator, '1', created.id, mutation(1), '1001')).status,
    ).toBe('succeeded');
    expect(gateway.calls.length).toBe(before);
  });
  it('keeps a created order checkpoint when confirmation times out, without reissuing the order', async () => {
    const state = await service.create(operator, '1', '3');
    readyToOrder(state.id);
    await service.quote(operator, '1', state.id, mutation(0));
    gateway.intercept = async (path) => {
      if (path === 'payment-confirm')
        throw new CheckoutGatewayError('CHECKOUT_OUTCOME_UNCERTAIN', 'Unconfirmed fixture', true);
      return undefined;
    };
    const input = mutation(1);
    await expect(service.submit(operator, '1', state.id, input)).rejects.toMatchObject({
      code: 'CHECKOUT_OUTCOME_UNCERTAIN',
    });
    const saved = await service.read(operator, '1', state.id);
    expect(saved.phase).toBe('uncertain');
    expect(saved.orderId).toBe('5001');
    const retry = await service.submit(operator, '1', state.id, input);
    expect(retry.status).toBe('uncertain');
    expect(gateway.calls.filter((c) => c.path === 'pos/order')).toHaveLength(1);
    await expect(service.submit(operator, '1', state.id, mutation(1))).rejects.toMatchObject({
      code: 'CHECKOUT_REVIEW_REQUIRED',
    });
  });
  it('creates an order from the server quote and does not represent an unpaid order as paid', async () => {
    const state = await service.create(operator, '1', '3');
    readyToOrder(state.id);
    await service.quote(operator, '1', state.id, mutation(0));
    const done = await service.submit(operator, '1', state.id, mutation(1));
    expect(done.status).toBe('succeeded');
    if (done.status !== 'succeeded') throw new Error('Expected submission');
    expect(done.result.paymentStatus).toBe('pending');
    expect(done.result.orderId).toBe('5001');
    const payload = gateway.calls.find((c) => c.path === 'pos/order')!.payload;
    expect(payload.admin_user_id).toBe(777);
    expect(payload.payment_method).toBe('coc');
    expect(publicState(done.state)).not.toHaveProperty('paymentConfirmation');
  });
  it('never reveals upstream secrets in the browser checkout representation', async () => {
    const state = await service.create(operator, '1', '3');
    const read = await service.read(operator, '1', state.id);
    expect(JSON.stringify(read)).not.toContain('private-api-token');
    expect(read).not.toHaveProperty('operatorCustomerId');
  });
  it('allows removing benefits without a fresh customer OTP while continuing to require proof for a new wallet spend', async () => {
    const checkout = await service.create(operator, '1', '3');
    await service.attachCustomer(operator, '1', checkout.id, mutation(0), '1001');
    expect(
      (await service.removeBenefit(operator, '1', checkout.id, mutation(1), 'coupon')).status,
    ).toBe('succeeded');
    expect(
      (await service.removeBenefit(operator, '1', checkout.id, mutation(2), 'gift-voucher')).status,
    ).toBe('succeeded');
    expect(
      (
        await service.wallet(operator, '1', checkout.id, mutation(3), {
          money: false,
          points: false,
          appliedMoney: '0.00',
          custom: false,
        })
      ).status,
    ).toBe('succeeded');
    await expect(
      service.wallet(operator, '1', checkout.id, mutation(4), {
        money: false,
        points: true,
        appliedMoney: '0.00',
        custom: false,
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_REQUIRED' });
  });
  it('repairs local invoice finalization after acknowledged confirmation without reissuing external order calls', async () => {
    let finalizations = 0;
    const repaired = checkoutService(repository, gateway, signingEnvironment, {
      migrationV2: true,
      assertCheckIn: async () => {},
      finalizeOrder: async () => {
        if (finalizations++ === 0)
          throw new AppError(503, 'INVOICE_FIXTURE_UNAVAILABLE', 'Fixture invoice failure');
        return { transactionId: 'FIXTURE-5001', invoice: 'FIXTURE-001' };
      },
    });
    const created = await repaired.create(operator, '1', '3');
    readyToOrder(created.id);
    await repaired.quote(operator, '1', created.id, mutation(0));
    const submit = mutation(1);
    await expect(repaired.submit(operator, '1', created.id, submit)).rejects.toMatchObject({
      code: 'INVOICE_FIXTURE_UNAVAILABLE',
    });
    expect(await repaired.read(operator, '1', created.id)).toMatchObject({
      phase: 'order-created',
      confirmationPhase: 'acknowledged',
      orderId: '5001',
      orderSubmissionOperationId: submit.operationId,
    });
    const input = mutation(1),
      done = await repaired.finalize(operator, '1', created.id, input);
    expect(done.status).toBe('succeeded');
    if (done.status === 'succeeded') expect(done.result.paymentStatus).toBe('pending');
    expect((await repaired.finalize(operator, '1', created.id, input)).status).toBe('succeeded');
    expect(gateway.calls.filter((call) => call.path === 'pos/order')).toHaveLength(1);
    expect(gateway.calls.filter((call) => call.path === 'payment-confirm')).toHaveLength(1);
    expect(finalizations).toBe(2);
    await expect(repaired.finalize(operator, '1', created.id, mutation(2))).rejects.toMatchObject({
      code: 'ORDER_FINALIZATION_REVIEW_REQUIRED',
    });
  });
  it('recovers a lost confirmation only after the created order is verified and repairs the original operation receipt', async () => {
    let proof = false,
      finalizations = 0;
    const recovery = checkoutService(repository, gateway, signingEnvironment, {
      migrationV2: true,
      now: () => clock,
      assertCheckIn: async () => {},
      verifyCreatedOrder: async () => {
        if (!proof)
          throw new AppError(409, 'CREATED_ORDER_SCOPE_MISMATCH', 'Fixture order missing');
      },
      finalizeOrder: async () => {
        finalizations++;
        return { transactionId: 'FIXTURE-5001', invoice: 'FIXTURE-001' };
      },
    });
    const created = await recovery.create(operator, '1', '3');
    readyToOrder(created.id);
    await recovery.quote(operator, '1', created.id, mutation(0));
    gateway.intercept = async (path) => {
      if (path === 'payment-confirm')
        throw new CheckoutGatewayError('CHECKOUT_OUTCOME_UNCERTAIN', 'Fixture lost response', true);
      return undefined;
    };
    const submit = mutation(1);
    await expect(recovery.submit(operator, '1', created.id, submit)).rejects.toMatchObject({
      code: 'CHECKOUT_OUTCOME_UNCERTAIN',
    });
    await expect(
      recovery.reconcileConfirmation(operator, '1', created.id, mutation(1)),
    ).rejects.toMatchObject({ code: 'CREATED_ORDER_SCOPE_MISMATCH' });
    expect(finalizations).toBe(0);
    expect((await recovery.read(operator, '1', created.id)).phase).toBe('uncertain');
    proof = true;
    const input = mutation(1),
      done = await recovery.reconcileConfirmation(operator, '1', created.id, input);
    expect(done.status).toBe('succeeded');
    expect(done.state).toMatchObject({
      orderId: '5001',
      phase: 'submitted',
      confirmationPhase: 'acknowledged',
      confirmationRecovery: null,
      busyOperationId: null,
    });
    expect((await recovery.operation(operator, '1', created.id, submit.operationId)).status).toBe(
      'succeeded',
    );
    expect((await recovery.submit(operator, '1', created.id, submit)).status).toBe('succeeded');
    expect((await recovery.reconcileConfirmation(operator, '1', created.id, input)).status).toBe(
      'succeeded',
    );
    expect(finalizations).toBe(1);
    proof = false;
    await expect(
      recovery.reconcileConfirmation(operator, '1', created.id, input),
    ).rejects.toMatchObject({ code: 'CREATED_ORDER_SCOPE_MISMATCH' });
    expect(gateway.calls.filter((call) => call.path === 'pos/order')).toHaveLength(1);
    expect(gateway.calls.filter((call) => call.path === 'payment-confirm')).toHaveLength(1);
  });
  it('fences a stale confirmation recovery worker when its lease is reclaimed with the same operation ID', async () => {
    const releases: (() => void)[] = [];
    let finalizations = 0;
    const recovery = checkoutService(repository, gateway, signingEnvironment, {
      migrationV2: true,
      now: () => clock,
      assertCheckIn: async () => {},
      verifyCreatedOrder: async () => new Promise<void>((resolve) => releases.push(resolve)),
      finalizeOrder: async () => {
        finalizations++;
        return { transactionId: 'FIXTURE-5001', invoice: null };
      },
    });
    const created = await recovery.create(operator, '1', '3');
    readyToOrder(created.id);
    await recovery.quote(operator, '1', created.id, mutation(0));
    gateway.intercept = async (path) => {
      if (path === 'payment-confirm')
        throw new CheckoutGatewayError('CHECKOUT_OUTCOME_UNCERTAIN', 'Fixture lost response', true);
      return undefined;
    };
    await expect(recovery.submit(operator, '1', created.id, mutation(1))).rejects.toMatchObject({
      code: 'CHECKOUT_OUTCOME_UNCERTAIN',
    });
    const input = mutation(1),
      first = recovery
        .reconcileConfirmation(operator, '1', created.id, input)
        .catch((error: unknown) => error);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect((await recovery.reconcileConfirmation(operator, '1', created.id, input)).status).toBe(
      'inflight',
    );
    await expect(
      recovery.reconcileConfirmation(operator, '1', created.id, mutation(1)),
    ).rejects.toMatchObject({ code: 'CHECKOUT_CONFIRMATION_IN_PROGRESS' });
    clock += 61_000;
    const second = recovery.reconcileConfirmation(operator, '1', created.id, input);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]!();
    expect(await first).toMatchObject({ code: 'CHECKOUT_OPERATION_CHANGED' });
    expect(repository.states.get(created.id)?.busyOperationId).toBe(input.operationId);
    releases[1]!();
    expect((await second).status).toBe('succeeded');
    expect(finalizations).toBe(1);
    expect(gateway.calls.filter((call) => call.path === 'payment-confirm')).toHaveLength(1);
  });
});
