import { describe, expect, it } from 'vitest';
import {
  walletPayload,
  pgDiscountPayload,
  storeDiscountPayload,
  couponPayload,
  giftVoucherPayload,
  exclusivePayload,
  syncCartPayload,
  orderPayload,
  confirmationPayload,
  removeBenefitPayload,
} from '../../src/modules/checkout/payloads.js';
import { financialYear, transactionIdentifier } from '../../src/modules/checkout/finalizer.js';
import { refundPreview, exchangeRetryable } from '../../src/modules/checkout/returns.js';
import { issueCustomerToken } from '../../src/modules/checkout/crypto.js';
import { createHmac } from 'node:crypto';
import { addCartPayload } from '../../src/modules/upstream.js';
import { goldenStdout } from '../golden/load.js';

const oracle = (input: unknown): unknown =>
  JSON.parse(goldenStdout('checkout', 'parity', JSON.stringify(input))) as unknown;
describe('checkout source-extracted parity', () => {
  it('preserves the original queued order SMS job payload', () => {
    expect(oracle({ operation: 'order_sms_payload' })).toEqual([
      { url: 'https://api.example.test/omnichannel-sms', payload: { order_id: 8401 } },
    ]);
  });
  it('preserves coupon/gift-voucher removals and custom gift face-value requests', () => {
    const calls = [];
    for (const endUser of [false, true]) {
      const context = { storeId: 1, tabId: 2, endUser },
        cart = { products: { items: [] } };
      for (const kind of ['coupon', 'gift-voucher'] as const)
        calls.push({ path: 'cart', payload: removeBenefitPayload(context, kind, cart) });
      calls.push({
        path: 'pos/product',
        payload: addCartPayload(context, '8900000000010', { gvprice: 1234 }),
      });
    }
    expect(calls).toEqual(oracle({ operation: 'gift_cart_controls' }));
  });
  it('preserves wallet, discounts, coupons, gift cards, membership, order and confirmation wire payloads', () => {
    const values = [];
    for (const endUser of [false, true]) {
      const c = { storeId: 1, tabId: 2, endUser },
        cart = { products: { items: [] } };
      values.push(
        { path: 'wallet', payload: walletPayload(c, cart, true, false, '12.34', true) },
        { path: 'pg', payload: pgDiscountPayload(c, cart, '25.50', true) },
        { path: 'store-discount-pg', payload: storeDiscountPayload(c, cart, '13.25', false) },
        { path: 'cart', payload: exclusivePayload(c, true) },
        { path: 'giftvoucher', payload: giftVoucherPayload(c, 'GC-fixture', '123456') },
        { path: 'coupon', payload: couponPayload(c, cart, 'COUPON') },
        { path: 'pos/order', payload: orderPayload(c, '3', '777', null, '100.00') },
        { path: 'pos/order', payload: orderPayload(c, '3', '777', null, '0.00') },
        { path: 'payment-confirm', payload: confirmationPayload(5001, 'coc', true, 'Fixture', 1) },
      );
    }
    values.push({
      path: 'syncart',
      payload: syncCartPayload({ storeId: 1, tabId: 2, endUser: false }, 'target-token', {
        products: { items: [] },
      }),
    });
    expect(values).toEqual(oracle({ operation: 'payloads' }));
  });
  it('preserves fiscal-year boundaries and transaction suffixes, including empty references', () => {
    const dates = [
      '2026-03-31T23:59:59',
      '2026-04-01T00:00:00',
      '2026-11-16T00:00:00',
      '2000-01-01T00:00:00',
    ];
    const transactions = [];
    for (const reference of ['', 'ABC-123456', '123', '12345678'])
      for (const pine of [0, 1, 3])
        for (const paytm of [0, 1, 2])
          for (const active of [false, true])
            transactions.push({ orderId: '5001', reference, pine, paytm, active });
    expect({
      fiscal: dates.map(financialYear),
      transactions: transactions.map((c) =>
        transactionIdentifier(c.orderId, c.reference, c.pine, c.paytm, c.active),
      ),
    }).toEqual(oracle({ operation: 'helpers', dates, transactions }));
  });
  it('preserves refund modes, exchange override and Python rounding', () => {
    const cases = [];
    for (const prepaid of [false, true])
      for (const exchangeOrder of [false, true])
        for (const superAdmin of [false, true])
          for (const amount of [100, 2.675, 133.125])
            cases.push({
              prepaid,
              exchangeOrder,
              superAdmin,
              amount,
              walletUsed: 0.005,
              giftVoucherUsed: 0.125,
            });
    expect(cases.map(refundPreview)).toEqual(oracle({ operation: 'refunds', cases }));
    expect(exchangeRetryable('DELIVERED', true)).toBe(true);
    expect(exchangeRetryable('REFUND_INITIATED', true)).toBe(false);
    expect(exchangeRetryable('EXCHANGE_INITIATED', false)).toBe(false);
  });
  it('issues server-owned customer identities with the source two-factor prefix and membership claim', () => {
    const key = 'fixture-signing-key-'.repeat(3),
      identity = {
        id: '1001',
        email: 'fixture@example.test',
        firstName: 'Fixture',
        lastName: '',
        telephone: '9000000000',
        twoFactor: true,
        exclusive: true,
        active: true,
      };
    const token = issueCustomerToken(identity, { hs512: key }, 1000000, 3600);
    expect(token.startsWith('2f.')).toBe(true);
    const [header, payload, signature] = token.slice(3).split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'HS512',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      sub: '1001',
      iat: 1000,
      exp: 4600,
      iev: true,
    });
    expect(signature).toBe(
      createHmac('sha512', key).update(`${header}.${payload}`).digest('base64url'),
    );
  });
});
