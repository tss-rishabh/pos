import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { AppError } from '../../domain/errors.js';
import { checkoutQuoteDisplay } from '../../domain/checkout-quote-display.js';
import type { Cart, CheckoutState, MutationResult } from './contracts.js';
import { Temporal } from '@js-temporal/polyfill';
import { publicSettlementNote } from './settlement-note.js';
import { wireId, type Payload } from './payloads.js';

/**
 * The checks the legacy page runs before AjaxOrderView (`create_order.html:5055-5075`, repeated at
 * `:6180-6200` and `:7311-7330`): a non-empty cart, a master salesperson and no per-line
 * "Not Selected" salesperson. Each line's select defaults to its saved value, else the master.
 */
export function assertOrderReady(
  state: Pick<CheckoutState, 'cart' | 'salespersonId' | 'lineSalespersons'>,
) {
  const cart = state.cart;
  const products = [
    ...(cart?.products.items ?? []),
    ...(cart?.complementary_products?.items ?? []),
  ];
  if (!products.length && !cart?.giftvouchers?.items.length)
    throw new AppError(422, 'CART_EMPTY', 'Please add some product into the cart.');
  const master = state.salespersonId;
  if (!master || products.some((item) => !(state.lineSalespersons[String(item.prod_id)] || master)))
    throw new AppError(422, 'SALESPERSON_REQUIRED', 'Please Select The Salesperson.');
}
/** The quote's `calculations.total`, unrounded, as the browser posted `total_payable` (2696). */
export function quoteTotal(quote: Payload): string {
  const meta = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(quote.meta);
  const value = z
    .union([z.string(), z.number()])
    .parse(meta.items.find((item) => item.name === 'calculations')?.total);
  const amount = new Decimal(value);
  if (!amount.isFinite() || amount.isNegative())
    throw new AppError(
      502,
      'INVALID_CHECKOUT_QUOTE',
      'Checkout returned an invalid payable amount.',
    );
  return amount.toString();
}
/**
 * `gc_data` (order/views.py:2733-2747): one entry per gift card in the current cart, keyed by
 * `gv_id`, with the saved card number and the saved start/end dates or "".
 */
export function orderGiftCardData(state: Pick<CheckoutState, 'giftCards'>, cart: Cart): Payload {
  const data: Payload = {};
  for (const item of cart.giftvouchers?.items ?? []) {
    const giftId = String(item.gv_id),
      card = state.giftCards[giftId];
    // Legacy AjaxOrderView crashes here (None.decode); fast checkout answers this message (3231-3233).
    if (!card)
      throw new AppError(422, 'GIFT_CARD_NUMBER_REQUIRED', 'Please add/save Gift Card No.');
    data[giftId] = giftCardWireData({ [giftId]: card })[giftId];
  }
  return data;
}
export function giftCardWireData(cards: CheckoutState['giftCards']): Payload {
  const format = (date: string) => {
    if (date === '') return '';
    const parsed = Temporal.PlainDate.from(date);
    return `${String(parsed.month).padStart(2, '0')}/${String(parsed.day).padStart(2, '0')}/${parsed.year}`;
  };
  return Object.fromEntries(
    Object.entries(cards).map(([id, card]) => [
      id,
      {
        gift_card_no: wireId(card.number),
        start_date: format(card.startDate),
        end_date: format(card.endDate),
      },
    ]),
  );
}
export function quotePayable(quote: Payload): string {
  const meta = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(quote.meta);
  const calculations = meta.items.find((item) => item.name === 'calculations');
  const value = calculations?.total;
  const parsed = z.union([z.string(), z.number()]).parse(value);
  const amount = new Decimal(parsed);
  if (!amount.isFinite() || amount.isNegative())
    throw new AppError(
      502,
      'INVALID_CHECKOUT_QUOTE',
      'Checkout returned an invalid payable amount.',
    );
  return amount.toFixed(2);
}
export function publicCart<T>(value: T): T {
  const sanitize = (node: unknown): unknown =>
    Array.isArray(node)
      ? node.map(sanitize)
      : typeof node === 'object' && node !== null
        ? Object.fromEntries(
            Object.entries(node)
              .filter(
                ([key]) =>
                  !/(?:token|password|secret|authorization|cookie|(?:^|_)pin(?:_|$))/i.test(key),
              )
              .map(([key, v]) => [key, sanitize(v)]),
          )
        : node;
  return sanitize(value) as T;
}
export function publicState(state: CheckoutState, cashbackCreditMessage?: string) {
  const {
    operatorCustomerId: _operatorCustomerId,
    storefrontCustomerId: _storefrontCustomerId,
    paymentConfirmation: _paymentConfirmation,
    confirmationRecovery: _confirmationRecovery,
    registrationRecovery: _registrationRecovery,
    settlementNote: _settlementNote,
    verifiedCustomerContact: _verifiedCustomerContact,
    verificationChallenge: _verificationChallenge,
    ...publicValue
  } = state;
  return {
    ...publicValue,
    settlementNote: publicSettlementNote(state.settlementNote),
    verificationChallenge: state.verificationChallenge
      ? {
          id: state.verificationChallenge.id,
          expiresAt: state.verificationChallenge.expiresAt,
          attempts: state.verificationChallenge.attempts,
          lastSentAt: state.verificationChallenge.lastSentAt,
          sent: state.verificationChallenge.sent,
          deliveryStatus: state.verificationChallenge.deliveryStatus ?? null,
          requestOperationId: state.verificationChallenge.requestOperationId ?? null,
          verifyOperationId: state.verificationChallenge.verifyOperationId ?? null,
        }
      : null,
    cart: state.cart ? publicCart(state.cart) : null,
    quote: state.quote ? publicCart(state.quote) : null,
    ...(state.quote
      ? { quoteDisplay: checkoutQuoteDisplay(state.quote, cashbackCreditMessage) }
      : {}),
  };
}
export function publicMutation(value: MutationResult, cashbackCreditMessage?: string) {
  return {
    state: publicState(value.state, cashbackCreditMessage),
    result: publicCart(value.result),
  };
}
