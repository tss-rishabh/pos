import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { checkoutService, giftCardWireData } from '../../src/modules/checkout/service.js';
import { giftCardRows } from '../../src/modules/checkout/gift-card-cart.js';
import { giftCardCode } from '../../src/modules/checkout/gift-cards.js';
import { CheckoutGatewayError } from '../../src/modules/checkout/gateway.js';
import {
  FixtureGateway,
  MemoryCheckoutRepository,
  operator,
  signingEnvironment,
} from './fixtures.js';

const now = Date.parse('2026-11-16T20:00:00Z');
/** Legacy normal path: the payment form is confirmed before the order is created. */
const cashOperation = crypto.randomUUID();
const cash = () => ({
  operationId: cashOperation,
  channel: 'cash' as const,
  cashAmount: '99.00',
  onlineAmount: '0.00',
  cashReceived: '99.00',
  message: 'Cash',
});
const mutation = (expectedVersion: number) => ({
  operationId: crypto.randomUUID(),
  expectedVersion,
});
let repository: MemoryCheckoutRepository,
  gateway: FixtureGateway,
  service: ReturnType<typeof checkoutService>;
beforeEach(() => {
  repository = new MemoryCheckoutRepository();
  gateway = new FixtureGateway();
  service = checkoutService(repository, gateway, signingEnvironment, {
    migrationV2: true,
    startPayment: async (_user, _store, orderId) => ({ orderId, status: 'paid' }),
    now: () => now,
    businessTimezone: 'Asia/Kolkata',
    assertCheckIn: async () => {},
    finalizeOrder: async () => ({ transactionId: 'FIXTURE', invoice: 'FIXTURE' }),
  });
});
describe('physical gift-card cart correctness', () => {
  it('sends unpicked gift card dates as "" in gc_data, as legacy AjaxOrderView', async () => {
    const created = await service.create(operator, '1', '3'),
      added = await service.addGiftCard(operator, '1', created.id, mutation(0), '80'),
      itemId = giftCardRows(added.state.cart!)[0]!.gv_id;
    await service.giftCardMetadata(operator, '1', created.id, mutation(1), itemId, {
      number: '990111',
      startDate: '',
      endDate: '2027-02-15',
    });
    repository.states.get(created.id)!.salespersonId = '5';
    await service.quote(operator, '1', created.id, mutation(2));
    expect((await service.submit(operator, '1', created.id, mutation(3), cash())).status).toBe(
      'succeeded',
    );
    const order = gateway.calls.find((call) => call.path === 'pos/order')!.payload;
    expect(order.gc_data).toEqual({
      [itemId]: { gift_card_no: 990111, start_date: '', end_date: '02/15/2027' },
    });
  });
  it('matches the original Python Hashids helper at safe-integer and signed-BIGINT boundaries', () => {
    const fixture = z
      .object({
        sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
        salt: z.string(),
        cases: z.array(z.object({ serial: z.string(), code: z.string() })),
      })
      .parse(
        JSON.parse(readFileSync('tests/checkout/gift-serial-vectors.json', 'utf8')) as unknown,
      );
    for (const value of fixture.cases)
      expect(giftCardCode(value.serial, fixture.salt)).toBe(value.code);
  });
  it('loads several cards with distinct exact IDs and per-card validity dates without a products quantity setter', async () => {
    const state = await service.create(operator, '1', '3'),
      done = await service.setLine(operator, '1', state.id, mutation(0), '80', 2);
    const rows = giftCardRows(done.state.cart!);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.gv_id)).size).toBe(2);
    expect(rows.every((row) => row.quantity === 1)).toBe(true);
    expect(Object.values(done.state.giftCardDates!)).toEqual([
      { startDate: '2026-11-17', endDate: '2027-02-15' },
      { startDate: '2026-11-17', endDate: '2027-02-15' },
    ]);
    expect(gateway.calls.filter((call) => call.path === 'pos/product')).toHaveLength(2);
    expect(
      gateway.calls.some(
        (call) => (call.payload.payload as { operation?: string } | undefined)?.operation === 'set',
      ),
    ).toBe(false);
    await expect(service.quote(operator, '1', state.id, mutation(1))).rejects.toMatchObject({
      code: 'GIFT_CARD_NUMBER_REQUIRED',
    });
  });
  it('replaces a custom value while retaining the physical serial, its lease and selected dates', async () => {
    const created = await service.create(operator, '1', '3'),
      added = await service.addGiftCard(operator, '1', created.id, mutation(0), '80'),
      oldId = giftCardRows(added.state.cart!)[0]!.gv_id;
    await service.giftCardMetadata(operator, '1', created.id, mutation(1), oldId, {
      number: '990_111',
      startDate: '2026-11-17',
      endDate: '2027-05-17',
    });
    const replaced = await service.giftCardValue(
        operator,
        '1',
        created.id,
        mutation(2),
        oldId,
        1234,
      ),
      rows = giftCardRows(replaced.state.cart!),
      id = rows[0]!.gv_id;
    expect(rows).toHaveLength(1);
    expect(id).not.toBe(oldId);
    expect(rows[0]).toMatchObject({ gvamount: 1234, price: 1234, custom_price: true });
    expect(replaced.state.giftCards[id]).toEqual({
      number: '990111',
      startDate: '2026-11-17',
      endDate: '2027-05-17',
    });
    expect(replaced.state.giftCards[oldId]).toBeUndefined();
    expect(repository.giftLeases.get('990111')).toBe(created.id);
    expect(replaced.state.giftCardValues).toEqual({ [id]: 1234 });
    const quoted = await service.quote(operator, '1', created.id, mutation(3));
    expect(quoted.status).toBe('succeeded');
    expect(giftCardWireData(replaced.state.giftCards)).toEqual({
      [id]: { gift_card_no: 990111, start_date: '11/17/2026', end_date: '05/17/2027' },
    });
    const reset = await service.giftCardValue(operator, '1', created.id, mutation(4), id, null);
    expect(giftCardRows(reset.state.cart!)[0]).toMatchObject({
      gvamount: 500,
      price: 500,
      custom_price: false,
    });
    expect(reset.state.giftCardValues).toEqual({});
    const resetId = giftCardRows(reset.state.cart!)[0]!.gv_id;
    expect(reset.state.giftCards[resetId]?.number).toBe('990111');
    await service.removeGiftCard(operator, '1', created.id, mutation(5), resetId);
    expect(repository.giftLeases.has('990111')).toBe(false);
  });
  it('removes a mismatched custom addition and keeps the previous physical card intact', async () => {
    const created = await service.create(operator, '1', '3'),
      added = await service.addGiftCard(operator, '1', created.id, mutation(0), '80'),
      oldId = giftCardRows(added.state.cart!)[0]!.gv_id;
    gateway.intercept = async (path, payload) => {
      if (
        path === 'pos/product' &&
        typeof payload.custom_data === 'object' &&
        payload.custom_data !== null &&
        'gvprice' in payload.custom_data
      ) {
        const details = payload.custom_data as Record<string, unknown>,
          cart = structuredClone(added.state.cart!);
        cart.giftvouchers!.items.push({
          gv_id: String(details.pos_gift_id),
          prod_id: 80,
          quantity: 1,
          price: 500,
          gvamount: 1234,
          custom_price: true,
        });
        for (const key of gateway.carts.keys()) gateway.carts.set(key, structuredClone(cart));
        return cart;
      }
      return undefined;
    };
    await expect(
      service.giftCardValue(operator, '1', created.id, mutation(1), oldId, 1234),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_VALUE_UNCONFIRMED' });
    const current = await service.read(operator, '1', created.id);
    expect(giftCardRows(current.cart!)).toEqual(giftCardRows(added.state.cart!));
    expect(current.phase).toBe('open');
  });
  it('rejects a changed custom face value at quote time and rejects invalid physical storage/date inputs before order dispatch', async () => {
    const created = await service.create(operator, '1', '3'),
      added = await service.addGiftCard(operator, '1', created.id, mutation(0), '80', 1234),
      id = giftCardRows(added.state.cart!)[0]!.gv_id;
    await expect(
      service.giftCardMetadata(operator, '1', created.id, mutation(1), id, {
        number: '990111',
        startDate: '0000-01-01',
        endDate: '2027-01-01',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_GIFT_CARD_DATES' });
    await expect(
      service.giftCardMetadata(operator, '1', created.id, mutation(1), id, {
        number: '99999999999999999990111',
        startDate: '2026-11-17',
        endDate: '2027-01-01',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_GIFT_CARD_SERIAL' });
    await service.giftCardMetadata(operator, '1', created.id, mutation(1), id, {
      number: '990111',
      startDate: '2026-11-17',
      endDate: '2027-01-01',
    });
    gateway.intercept = async (path) =>
      path === 'processorder'
        ? {
            ...structuredClone(added.state.cart!),
            giftvouchers: {
              items: [{ ...giftCardRows(added.state.cart!)[0], price: 500, gvamount: 1234 }],
            },
          }
        : undefined;
    await expect(service.quote(operator, '1', created.id, mutation(2))).rejects.toMatchObject({
      code: 'GIFT_CARD_VALUE_CHANGED',
    });
    expect(gateway.calls.some((call) => call.path === 'pos/order')).toBe(false);
  });
  it('requires a gift product before mutation, and freezes an unidentified addition', async () => {
    // Legacy calls unpatched API-v2: no gift-card upstream contract is required any more.
    const created = await service.create(operator, '1', '3');
    await expect(
      service.addGiftCard(operator, '1', created.id, mutation(0), '10', 1234),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_PRODUCT_REQUIRED' });
    expect(gateway.calls.filter((call) => call.path === 'pos/product')).toHaveLength(0);
    gateway.intercept = async (path) =>
      path === 'pos/product'
        ? {
            products: { items: [] },
            giftvouchers: {
              items: [{ gv_id: '8001', prod_id: 80, quantity: 1, price: 500, gvamount: 500 }],
            },
          }
        : undefined;
    const input = mutation(0);
    await expect(
      service.addGiftCard(operator, '1', created.id, input, '80'),
    ).rejects.toBeInstanceOf(CheckoutGatewayError);
    expect((await service.addGiftCard(operator, '1', created.id, input, '80')).status).toBe(
      'uncertain',
    );
    await expect(
      service.addGiftCard(operator, '1', created.id, mutation(0), '80'),
    ).rejects.toMatchObject({ code: 'CHECKOUT_REVIEW_REQUIRED' });
    expect(gateway.calls.filter((call) => call.path === 'pos/product')).toHaveLength(1);
  });
});
