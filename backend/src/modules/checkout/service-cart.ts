import { Decimal } from 'decimal.js';
import type { Principal } from '../../domain/access.js';
import { requireRole } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { MutationInput } from './contracts.js';
import { CheckoutGatewayError } from './gateway.js';
import { validateGiftCardSerial } from './gift-cards.js';
import { Temporal } from '@js-temporal/polyfill';
import { amount, minorUnits } from '../../domain/money.js';
import {
  createSettlementNote,
  publicSettlementNote,
  settlementMessageSchema,
} from './settlement-note.js';
import { discountMetadataSchema } from './discounts/policy.js';
import { giftCardRows } from './gift-card-cart.js';
import {
  couponPayload,
  exclusivePayload,
  giftVoucherPayload,
  pgDiscountPayload,
  removeBenefitPayload,
  storeDiscountPayload,
  walletPayload,
} from './payloads.js';
import { quotePayable } from './service-public.js';
import type { CheckoutServiceCore } from './service-core.js';

/**
 * Cart lines, draft initialisation, clearing, and the benefits applied to the cart (coupon, wallet,
 * gift vouchers and cards, exclusive, discounts, salesperson, settlement note).
 */
export function checkoutCartMethods(core: CheckoutServiceCore) {
  const {
    repository,
    environment,
    options,
    cartPath,
    get,
    context,
    readCart,
    requireVerified,
    editable,
    mutate,
    cartMutation,
    gifts,
    changeLine,
    clearCheckout,
  } = core;
  return {
    setLine(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      productId: string,
      quantity: number,
    ) {
      return mutate(user, storeId, id, input, 'cart.line.set', { productId, quantity }, (state) =>
        changeLine(state, input.operationId, productId, quantity),
      );
    },
    initializeDraft(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'cart.draft.initialize', {}, async (state) => {
        editable(state);
        if (!state.draftImport)
          throw new AppError(
            409,
            'CHECKOUT_DRAFT_MANIFEST_REQUIRED',
            'This checkout has no saved line manifest.',
          );
        if (state.draftImport.status === 'complete')
          return { state, result: { initialized: true } };
        let next = state;
        for (const line of state.draftImport.lineItems) {
          if (next.draftImport!.completedProductIds.includes(line.productId)) continue;
          const changed = await changeLine(next, input.operationId, line.productId, line.quantity);
          await repository.checkpoint(changed.state, input.operationId);
          const product = changed.state.cart?.products.items.find(
            (item) => String(item.prod_id) === line.productId,
          );
          const actual = product
            ? Number(product.quantity)
            : giftCardRows(changed.state.cart!)
                .filter((item) => item.prod_id === line.productId)
                .reduce((total, item) => total + item.quantity, 0);
          if (actual !== line.quantity)
            throw new AppError(
              409,
              'CHECKOUT_DRAFT_QUANTITY_UNCONFIRMED',
              'A saved sale quantity could not be confirmed. Review its availability before continuing.',
            );
          next = {
            ...changed.state,
            draftImport: {
              ...next.draftImport!,
              completedProductIds: [...next.draftImport!.completedProductIds, line.productId],
            },
          };
          await repository.checkpoint(next, input.operationId);
        }
        return {
          state: { ...next, draftImport: { ...next.draftImport!, status: 'complete' } },
          result: { initialized: true },
        };
      });
    },
    clear(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'cart.clear', {}, (state) =>
        clearCheckout(state, input.operationId),
      );
    },
    detachCustomer(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'customer.detach', {}, (state) => {
        editable(state);
        return state.customerId
          ? clearCheckout(state, input.operationId, 'customer-detach')
          : Promise.resolve({ state, result: { customerDetached: false } });
      });
    },
    coupon(user: Principal, storeId: string, id: string, input: MutationInput, code: string) {
      return mutate(user, storeId, id, input, 'coupon.apply', { code }, async (state) => {
        // AjaxCouponView (order/views.py:2365-2391): only a company email (the customer's, or the
        // operator's for a walk-in cart) must be verified to use an employee coupon.
        const email = state.customerId
          ? ((await repository.customer(state.customerId))?.email ?? '')
          : user.email;
        if (email.includes('@thesouledstore.') && (await repository.isEmployeeCoupon(code))) {
          try {
            await requireVerified(user, state);
          } catch (error) {
            if (error instanceof AppError && error.code === 'CUSTOMER_VERIFICATION_REQUIRED')
              throw new AppError(
                403,
                'CUSTOMER_VERIFICATION_REQUIRED',
                'Please verify the user to use Employee Coupon.',
              );
            throw error;
          }
        }
        return cartMutation(
          state,
          'coupon',
          couponPayload(context(state), await readCart(state), code),
        );
      });
    },
    removeBenefit(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      kind: 'coupon' | 'gift-voucher',
    ) {
      return mutate(user, storeId, id, input, `benefit.${kind}.remove`, {}, async (state) =>
        cartMutation(
          state,
          cartPath,
          removeBenefitPayload(context(state), kind, await readCart(state)),
        ),
      );
    },
    wallet(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      request: { money: boolean; points: boolean; appliedMoney: string; custom: boolean },
    ) {
      return mutate(user, storeId, id, input, 'wallet.update', request, async (state) => {
        if (request.money || request.points) await requireVerified(user, state);
        return cartMutation(
          state,
          'wallet',
          walletPayload(
            context(state),
            await readCart(state),
            request.money,
            request.points,
            request.appliedMoney,
            request.custom,
          ),
        );
      });
    },
    giftVoucher(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      code: string,
      pin: string,
    ) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'gift-voucher.apply',
        { code, pin },
        async (state) => {
          await requireVerified(user, state);
          try {
            return await cartMutation(
              state,
              'giftvoucher',
              giftVoucherPayload(context(state), code, pin),
            );
          } catch (error) {
            if (error instanceof CheckoutGatewayError && error.pinRequired)
              throw new AppError(
                422,
                pin === '0' ? 'GIFT_VOUCHER_PIN_REQUIRED' : 'GIFT_VOUCHER_PIN_INVALID',
                pin === '0'
                  ? 'Please Enter the GIFT CARD PIN.'
                  : 'The gift card PIN was not accepted. Check it and try again.',
              );
            throw error;
          }
        },
      );
    },
    giftCardMetadata(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      giftId: string,
      metadata: { number: string; startDate: string; endDate: string },
    ) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'gift-card.save',
        { giftId, ...metadata },
        async (state) => {
          editable(state);
          const cart = await readCart(state);
          if (!(cart.giftvouchers?.items || []).some((item) => String(item.gv_id) === giftId))
            throw new AppError(
              404,
              'GIFT_CARD_ITEM_NOT_FOUND',
              'Gift card item was not found in this sale.',
            );
          const number = await validateGiftCardSerial(
            repository,
            metadata.number,
            environment.giftCardSalt,
          );
          if (
            Object.entries(state.giftCards).some(
              ([key, card]) => key !== giftId && card.number === number,
            )
          )
            throw new AppError(
              409,
              'GIFT_CARD_DUPLICATE',
              'This card number is already applied to this sale.',
            );
          // AjaxSaveGcDateView (order/views.py:4385-4398) stores the picked dates verbatim and
          // gc_data sends "" for an unpicked date.
          const start = metadata.startDate ? Temporal.PlainDate.from(metadata.startDate) : null,
            end = metadata.endDate ? Temporal.PlainDate.from(metadata.endDate) : null;
          if (
            (start && start.year < 1) ||
            (end && end.year > 9999) ||
            (start && end && Temporal.PlainDate.compare(end, start) < 0)
          )
            throw new AppError(
              422,
              'INVALID_GIFT_CARD_DATES',
              'The gift card end date must follow its start date.',
            );
          await repository.acquireGiftCard(id, number);
          const old = state.giftCards[giftId];
          if (old && old.number !== number) await repository.releaseGiftCard(id, old.number);
          return {
            state: {
              ...state,
              cart,
              quote: null,
              phase: 'open',
              giftCards: {
                ...state.giftCards,
                [giftId]: {
                  number,
                  startDate: start?.toString() ?? '',
                  endDate: end?.toString() ?? '',
                },
              },
            },
            result: {
              giftId,
              number,
              startDate: start?.toString() ?? '',
              endDate: end?.toString() ?? '',
            },
          };
        },
      );
    },
    removeGiftCard(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      giftId: string,
    ) {
      return mutate(user, storeId, id, input, 'gift-card.remove', { giftId }, async (state) => {
        editable(state);
        return gifts.remove(state, input.operationId, giftId);
      });
    },
    addGiftCard(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      productId: string,
      customValue?: number,
    ) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'gift-card.add',
        { productId, customValue },
        async (state) => {
          editable(state);
          return gifts.add(state, input.operationId, productId, customValue);
        },
      );
    },
    giftCardValue(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      giftId: string,
      customValue: number | null,
    ) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'gift-card.value',
        { giftId, customValue },
        async (state) => {
          editable(state);
          return gifts.replace(state, input.operationId, giftId, customValue);
        },
      );
    },
    exclusive(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      enabled: boolean,
    ) {
      return mutate(user, storeId, id, input, 'membership.update', { enabled }, async (state) => {
        if (state.customerId)
          throw new AppError(
            409,
            'CUSTOMER_MEMBERSHIP_AUTHORITATIVE',
            'Connected customers use their own membership eligibility.',
          );
        return cartMutation(state, cartPath, exclusivePayload(context(state), enabled));
      });
    },
    discount(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      request: {
        kind: 'pg' | 'store';
        amount: string;
        apply: boolean;
        remark?: string;
        reason?: string;
      },
    ) {
      // Legacy has no role check on store-PG (AjaxStoreDiscountPGView, order/views.py:2237-2283) or
      // removals; old-PG apply is limited to PG_DISC_ROLE_PERM ("You do not have permission.").
      if (options.discounts)
        options.discounts.assertApplyPermission(user, request.kind, request.apply);
      else if (request.kind === 'pg' && request.apply) requireRole(user, [1, 2, 3, 4]);
      return mutate(user, storeId, id, input, 'discount.update', request, async (state) => {
        if (request.apply && new Decimal(request.amount).isZero())
          throw new AppError(422, 'DISCOUNT_NOT_APPLICABLE', 'A nonzero discount is required.');
        const details = discountMetadataSchema.safeParse({
          ...(state.discountMetadata || { pg: null, store: null }),
          [request.kind]: request.apply
            ? {
                remark: request.remark,
                ...(request.kind === 'store' ? { reason: request.reason } : {}),
              }
            : null,
        });
        if (!details.success)
          throw new AppError(
            422,
            'DISCOUNT_REMARK_REQUIRED',
            'Save a meaningful discount remark and store discount reason.',
          );
        const metadata = details.data;
        const cart = await readCart(state);
        const changed = await cartMutation(
          state,
          request.kind === 'pg' ? 'pg' : 'store-discount-pg',
          request.kind === 'pg'
            ? pgDiscountPayload(context(state), cart, request.amount, request.apply)
            : storeDiscountPayload(context(state), cart, request.amount, request.apply),
        );
        return { ...changed, state: { ...changed.state, discountMetadata: metadata } };
      });
    },
    salesperson(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      salespersonId: string,
      productId?: string,
    ) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'salesperson.assign',
        { salespersonId, productId },
        async (state) => {
          editable(state);
          // AjaxAddSalesPersonView / AjaxAddSalesPersonPerProductView (order/views.py:2969-3019).
          if (salespersonId === '0') {
            const current = productId ? state.lineSalespersons[productId] : state.salespersonId;
            if (!current || current === '0')
              throw new AppError(
                422,
                'SALESPERSON_NOT_SELECTED',
                'Please Select Valid Salesperson.',
              );
            return {
              state: productId
                ? { ...state, lineSalespersons: { ...state.lineSalespersons, [productId]: '0' } }
                : {
                    ...state,
                    salespersonId: null,
                    lineSalespersons: Object.fromEntries(
                      Object.keys(state.lineSalespersons).map((key) => [key, '0']),
                    ),
                  },
              result: { salespersonId: null, productId: productId || null, removed: true },
            };
          }
          if (!/^[1-9]\d{0,9}$/.test(salespersonId) || BigInt(salespersonId) > 2147483647n)
            throw new AppError(
              422,
              'SALESPERSON_ID_INVALID',
              'Select a salesperson supported by the order system.',
            );
          if (
            productId &&
            ![
              ...(state.cart?.products.items ?? []),
              ...(state.cart?.giftvouchers?.items ?? []),
              ...(state.cart?.complementary_products?.items ?? []),
            ].some((item) => String(item.prod_id) === productId)
          )
            throw new AppError(
              422,
              'SALESPERSON_PRODUCT_UNAVAILABLE',
              'Select a product in this checkout before assigning its salesperson.',
            );
          if (!(await repository.salesperson(storeId, salespersonId)))
            throw new AppError(
              422,
              'SALESPERSON_NOT_ASSIGNED',
              'Select an active salesperson assigned to this store.',
            );
          return {
            state: productId
              ? {
                  ...state,
                  lineSalespersons: { ...state.lineSalespersons, [productId]: salespersonId },
                }
              : {
                  // The sale-level choice overwrites every per-line choice (legacy scan_iter set).
                  ...state,
                  salespersonId,
                  lineSalespersons: Object.fromEntries(
                    Object.keys(state.lineSalespersons).map((key) => [key, salespersonId]),
                  ),
                },
            result: { salespersonId, productId: productId || null, removed: false },
          };
        },
      );
    },
    async readSettlementNote(user: Principal, storeId: string, id: string) {
      const state = await get(user, storeId, id);
      await options.assertCheckIn(user.id, storeId, state.counterId);
      return state.settlementNote ?? null;
    },
    async settlementNote(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      message: string,
      cashReceived: string,
    ) {
      const parsed = settlementMessageSchema.safeParse(message);
      if (!parsed.success)
        throw new AppError(
          422,
          'PAYMENT_NOTE_INVALID',
          'Enter a payment note up to 255 characters using text supported by the store ledger.',
        );
      return mutate(
        user,
        storeId,
        id,
        input,
        'settlement-note.update',
        { message: parsed.data, cashReceived },
        async (state) => {
          editable(state);
          if (state.phase !== 'quoted' || !state.quote)
            throw new AppError(409, 'CHECKOUT_QUOTE_REQUIRED', 'Review the final quote first.');
          const payable = quotePayable(state.quote),
            cash = minorUnits(cashReceived);
          if (minorUnits(payable) <= 0n || cash < minorUnits(payable) || cash > 9999999999n)
            throw new AppError(
              422,
              'CASH_NOTE_AMOUNT_INVALID',
              'The received cash must cover this positive final payable.',
            );
          const note = createSettlementNote(
            state,
            parsed.data,
            payable,
            amount(cash),
            environment.hs256 || environment.hs512 || '',
          );
          return {
            state: { ...state, settlementNote: note },
            result: { settlementNote: publicSettlementNote(note) },
          };
        },
      );
    },
  };
}
