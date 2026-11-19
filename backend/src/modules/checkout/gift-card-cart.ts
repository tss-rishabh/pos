import { Temporal } from '@js-temporal/polyfill';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { addCartPayload, deleteCartPayload } from '../upstream.js';
import type { Cart, CheckoutRepository, CheckoutState } from './contracts.js';
import { newGiftItemId } from './crypto.js';
import { CheckoutGatewayError, type CheckoutEnvironment } from './gateway.js';
import { wireId, type Payload } from './payloads.js';

const itemId = z.union([identifier, z.number().int().positive().safe()]).transform(String);
const quantity = z
  .union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(1).max(999));
const giftRow = z.object({ gv_id: itemId, prod_id: itemId, quantity }).passthrough();
export const giftCardRows = (cart: Cart) =>
  z
    .array(giftRow)
    .max(100)
    .parse(cart.giftvouchers?.items || []);
export function giftCardAmount(item: Record<string, unknown>): Decimal {
  const value = z
    .union([z.string().regex(/^\d+(?:\.\d+)?$/), z.number().finite().nonnegative()])
    .safeParse(item.gvamount ?? item.price);
  if (!value.success)
    throw new AppError(
      502,
      'INVALID_GIFT_CARD_VALUE',
      'The gift card value could not be confirmed.',
    );
  const amount = new Decimal(value.data);
  if (amount.lte(0) || amount.decimalPlaces() > 2)
    throw new AppError(
      502,
      'INVALID_GIFT_CARD_VALUE',
      'The gift card value could not be confirmed.',
    );
  return amount;
}
export function withGiftCardDates(
  state: CheckoutState,
  cart: Cart,
  now: number,
  expiryDays = 90,
  zone = 'Asia/Kolkata',
) {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).toPlainDate(),
    defaults = { startDate: today.toString(), endDate: today.add({ days: expiryDays }).toString() };
  const rows = giftCardRows(cart),
    dates: NonNullable<CheckoutState['giftCardDates']> = {},
    values: NonNullable<CheckoutState['giftCardValues']> = {};
  for (const row of rows) {
    dates[row.gv_id] = state.giftCardDates?.[row.gv_id] || defaults;
    const custom = state.giftCardValues?.[row.gv_id];
    if (custom !== undefined) values[row.gv_id] = custom;
  }
  return { giftCardDates: dates, giftCardValues: values };
}
export function assertGiftCardValues(state: CheckoutState, cart: Cart) {
  for (const row of giftCardRows(cart)) {
    giftCardAmount(row);
    if (row.quantity !== 1)
      throw new AppError(
        409,
        'GIFT_CARD_QUANTITY_INVALID',
        'Each physical gift card must have its own card number. Remove the grouped card and add individual cards.',
      );
    const custom = state.giftCardValues?.[row.gv_id];
    if (custom !== undefined && !matchesCustomValue(row, custom))
      throw new AppError(
        409,
        'GIFT_CARD_VALUE_CHANGED',
        'The gift card value changed. Restore the intended value before creating this order.',
      );
  }
}
function matchesCustomValue(row: Record<string, unknown>, custom: number) {
  try {
    return (
      giftCardAmount(row).eq(custom) &&
      giftCardAmount({ price: row.price }).eq(custom) &&
      row.custom_price === true
    );
  } catch {
    return false;
  }
}
interface GiftCartActions {
  read(state: CheckoutState, token?: string): Promise<Cart>;
  change(
    state: CheckoutState,
    path: string,
    payload: Payload,
    token?: string,
  ): Promise<{ state: CheckoutState; result: Payload }>;
  token(state: CheckoutState): Promise<string>;
}
type CartProduct = NonNullable<Awaited<ReturnType<CheckoutRepository['cartProduct']>>>;
export function giftCardOperations(
  repository: CheckoutRepository,
  environment: CheckoutEnvironment,
  actions: GiftCartActions,
  cartPath: string,
) {
  const context = (state: CheckoutState) => ({
    storeId: wireId(state.storeId),
    tabId: state.tabId,
    endUser: state.customerId !== null,
  });
  const product = async (id: string) => {
    const row = await repository.cartProduct(id);
    if (!row || row.type !== 8)
      throw new AppError(422, 'GIFT_CARD_PRODUCT_REQUIRED', 'Select a gift card product.');
    if (!row.barcode)
      throw new AppError(422, 'PRODUCT_BARCODE_MISSING', 'This product has no barcode.');
    return row;
  };
  async function remove(
    state: CheckoutState,
    operationId: string,
    giftId: string,
    cart?: Cart,
    auth?: string,
    keepLease = false,
  ) {
    const token = auth || (await actions.token(state)),
      current = cart || (await actions.read(state, token)),
      item = giftCardRows(current).find((row) => row.gv_id === giftId);
    if (!item)
      throw new AppError(
        404,
        'GIFT_CARD_ITEM_NOT_FOUND',
        'Gift card item was not found in this sale.',
      );
    const changed = await actions.change(
        state,
        cartPath,
        deleteCartPayload(context(state), wireId(item.prod_id), wireId(giftId)),
        token,
      ),
      cards = { ...state.giftCards };
    await repository.checkpoint(changed.state, operationId);
    const before = giftCardRows(current),
      after = giftCardRows(changed.state.cart!);
    if (
      after.some((row) => row.gv_id === giftId) ||
      after.length !== before.length - 1 ||
      before.some((row) => row.gv_id !== giftId && !after.some((next) => next.gv_id === row.gv_id))
    )
      throw new CheckoutGatewayError(
        'GIFT_CARD_REMOVE_OUTCOME_UNCERTAIN',
        'The gift card removal could not be confirmed. Review the checkout before trying again.',
        true,
      );
    delete cards[giftId];
    const next = { ...changed.state, giftCards: cards };
    await repository.checkpoint(next, operationId);
    if (state.giftCards[giftId] && !keepLease)
      await repository.releaseGiftCard(state.id, state.giftCards[giftId]!.number);
    return { ...changed, state: next };
  }
  async function add(
    state: CheckoutState,
    operationId: string,
    productId: string,
    customValue?: number,
    cart?: Cart,
    auth?: string,
    knownProduct?: CartProduct,
  ) {
    if (
      customValue !== undefined &&
      (!Number.isInteger(customValue) || customValue < 1 || customValue > 10000)
    )
      throw new AppError(
        422,
        'INVALID_GIFT_CARD_VALUE',
        'Gift card value must be a whole amount from 1 to 10000.',
      );
    const selected = knownProduct || (await product(productId)),
      token = auth || (await actions.token(state)),
      current = cart || (await actions.read(state, token)),
      before = giftCardRows(current),
      id = newGiftItemId();
    if (selected.type !== 8 || !selected.barcode)
      throw new AppError(
        422,
        'GIFT_CARD_PRODUCT_REQUIRED',
        'Select a gift card product with a barcode.',
      );
    if (before.length >= 100)
      throw new AppError(422, 'GIFT_CARD_LIMIT', 'A sale can contain at most 100 gift cards.');
    const changed = await actions.change(
      state,
      'pos/product',
      addCartPayload(context(state), selected.barcode, {
        pos_gift_id: id,
        ...(customValue !== undefined ? { gvprice: customValue } : {}),
      }),
      token,
    );
    await repository.checkpoint(changed.state, operationId);
    const after = giftCardRows(changed.state.cart!),
      added = after.find((row) => row.gv_id === id);
    if (
      !added ||
      added.prod_id !== productId ||
      added.quantity !== 1 ||
      after.length !== before.length + 1 ||
      before.some((row) => !after.some((next) => next.gv_id === row.gv_id))
    )
      throw new CheckoutGatewayError(
        'GIFT_CARD_ADD_OUTCOME_UNCERTAIN',
        'The gift card item could not be identified. Review the checkout before trying again.',
        true,
      );
    let matched = true;
    if (customValue !== undefined) {
      matched = matchesCustomValue(added, customValue);
    }
    if (!matched) {
      await remove(changed.state, operationId, id, changed.state.cart!, token);
      throw new AppError(
        502,
        'GIFT_CARD_VALUE_UNCONFIRMED',
        'The requested gift card value was not confirmed. The new card was removed; refresh the checkout before continuing.',
      );
    }
    const next = {
      ...changed.state,
      giftCardValues: {
        ...changed.state.giftCardValues,
        ...(customValue !== undefined ? { [id]: customValue } : {}),
      },
    };
    await repository.checkpoint(next, operationId);
    return {
      state: next,
      result: {
        giftId: id,
        value: giftCardAmount(added).toFixed(2),
        customValue: customValue ?? null,
      },
    };
  }
  return {
    add,
    remove,
    async setQuantity(
      state: CheckoutState,
      operationId: string,
      productId: string,
      target: number,
      selected: CartProduct,
      cart: Cart,
      token: string,
    ) {
      if (target > 100)
        throw new AppError(422, 'GIFT_CARD_LIMIT', 'A sale can contain at most 100 gift cards.');
      const existing = giftCardRows(cart).filter((row) => row.prod_id === productId);
      if (existing.some((row) => row.quantity !== 1))
        throw new AppError(
          409,
          'GIFT_CARD_QUANTITY_INVALID',
          'Remove the grouped gift card and add individual cards.',
        );
      let current = state,
        currentCart = cart;
      for (let index = existing.length; index < target; index++) {
        const result = await add(
          current,
          operationId,
          productId,
          undefined,
          currentCart,
          token,
          selected,
        );
        current = result.state;
        currentCart = current.cart!;
      }
      const removable = [...existing].sort(
        (a, b) =>
          Number(Boolean(state.giftCards[a.gv_id])) - Number(Boolean(state.giftCards[b.gv_id])),
      );
      for (let index = 0; index < existing.length - target; index++) {
        const result = await remove(
          current,
          operationId,
          removable[index]!.gv_id,
          currentCart,
          token,
        );
        current = result.state;
        currentCart = current.cart!;
      }
      return { state: current, result: { quantity: target } };
    },
    async replace(state: CheckoutState, operationId: string, giftId: string, value: number | null) {
      const token = await actions.token(state),
        cart = await actions.read(state, token),
        old = giftCardRows(cart).find((row) => row.gv_id === giftId);
      if (!old)
        throw new AppError(
          404,
          'GIFT_CARD_ITEM_NOT_FOUND',
          'Gift card item was not found in this sale.',
        );
      const added = await add(state, operationId, old.prod_id, value ?? undefined, cart, token),
        newId = String(added.result.giftId),
        removed = await remove(added.state, operationId, giftId, added.state.cart!, token, true),
        metadata = state.giftCards[giftId],
        dates = state.giftCardDates?.[giftId];
      const next = {
        ...removed.state,
        giftCards: { ...removed.state.giftCards, ...(metadata ? { [newId]: metadata } : {}) },
        giftCardDates: { ...removed.state.giftCardDates, ...(dates ? { [newId]: dates } : {}) },
      };
      await repository.checkpoint(next, operationId);
      return { state: next, result: added.result };
    },
  };
}
