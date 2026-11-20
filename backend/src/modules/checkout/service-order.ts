import { z } from 'zod';
import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { processPayload, validatePayload } from '../upstream.js';
import { cartSchema, type CheckoutState, type MutationInput } from './contracts.js';
import { CheckoutGatewayError } from './gateway.js';
import { operationHash } from './crypto.js';
import type { PaymentInput } from './payments/contracts.js';
import { validatePaymentSplit } from './payments/repository.js';
import { assertGiftCardValues } from './gift-card-cart.js';
import { confirmationPayload, orderPayload } from './payloads.js';
import {
  assertOrderReady,
  quoteTotal,
  orderGiftCardData,
  quotePayable,
  publicCart,
  publicMutation,
} from './service-public.js';
import type { CheckoutServiceCore, MutationReply } from './service-core.js';

/**
 * Quote, PG-discount approval, order submission, finalization, confirmation reconciliation and
 * operation status.
 */
export function checkoutOrderMethods(core: CheckoutServiceCore) {
  const {
    repository,
    gateway,
    environment,
    options,
    now,
    get,
    context,
    token,
    readCart,
    editable,
    mutate,
    completeOrder,
  } = core;
  return {
    quote(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'quote.create', {}, async (state) => {
        editable(state);
        const auth = await token(state),
          c = context(state);
        await gateway.api('validatecheckout', validatePayload(c), auth);
        const cart = await readCart(state);
        const quote = z
          .record(z.string(), z.unknown())
          .parse(await gateway.api('processorder', processPayload(c, cart), auth));
        const quotedCart = cartSchema.parse(quote);
        assertGiftCardValues(state, quotedCart);
        if (
          !state.customerId &&
          quotedCart.products.items.some((item) => Number(item.prod_type) === 5)
        )
          throw new AppError(
            422,
            'CUSTOMER_REQUIRED_FOR_MEMBERSHIP',
            'Connect a customer before purchasing membership.',
          );
        for (const item of quotedCart.giftvouchers?.items || []) {
          const giftId = String(item.gv_id);
          if (!state.giftCards[giftId])
            throw new AppError(
              422,
              'GIFT_CARD_NUMBER_REQUIRED',
              'Save a gift card number for every gift card in this sale.',
            );
        }
        return {
          state: { ...state, cart: quotedCart, quote, phase: 'quoted' },
          result: { quote: publicCart(quote), payable: quotePayable(quote) },
        };
      });
    },
    async discountApproval(user: Principal, storeId: string, id: string) {
      const state = await get(user, storeId, id);
      await options.assertCheckIn(user.id, storeId, state.counterId);
      if (!options.discounts)
        throw new AppError(
          503,
          'DISCOUNT_APPROVAL_UNAVAILABLE',
          'Manager discount approval is not configured.',
        );
      return options.discounts.describe(user, state);
    },
    requestDiscountApproval(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'discount.approval.request', {}, async (state) => {
        if (!options.discounts)
          throw new AppError(
            503,
            'DISCOUNT_APPROVAL_UNAVAILABLE',
            'Manager discount approval is not configured.',
          );
        return {
          state,
          result: { discountApproval: await options.discounts.request(user, state) },
        };
      });
    },
    confirmDiscountApproval(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      code: string,
    ) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'discount.approval.confirm',
        { code },
        async (state) => {
          if (!options.discounts)
            throw new AppError(
              503,
              'DISCOUNT_APPROVAL_UNAVAILABLE',
              'Manager discount approval is not configured.',
            );
          return {
            state,
            result: { discountApproval: await options.discounts.confirm(user, state, code) },
          };
        },
      );
    },
    async submit(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      payment: PaymentInput | null = null,
    ) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'order.create',
        payment ? { payment } : {},
        async (state) => {
          // Legacy order flow: the page first runs ajax-validate-process-order (validatecheckout +
          // processorder, our quote), then AjaxOrderView (order/views.py:2686-2840).
          if (state.phase !== 'quoted' || !state.quote)
            throw new AppError(
              409,
              'CHECKOUT_QUOTE_REQUIRED',
              'Review an authoritative quote before creating the order.',
            );
          if (!options.finalizeOrder)
            throw new AppError(
              503,
              'ORDER_FINALIZER_UNAVAILABLE',
              'Order finalization is not configured.',
            );
          assertOrderReady(state);
          const payable = quotePayable(state.quote);
          if (payment) {
            if (!options.startPayment)
              throw new AppError(
                503,
                'PAYMENT_UNAVAILABLE',
                'Counter payments are not configured.',
              );
            // The legacy form is validated before `ajax-order` (create_order.html:5820-5870).
            validatePaymentSplit(payment, payable);
          }
          // Without `payment` (offline sync, recovery) the order is created and paid separately;
          // the counter UI always confirms the payment form first.
          const auth = await token(state),
            c = context(state);
          // get_user_cart (2731) supplies the gift-card IDs for gc_data (2733-2747).
          const cart = await readCart(state, auth);
          const approval = options.discounts
            ? await options.discounts.authorize(user, state)
            : null;
          const payload = orderPayload(
            c,
            state.counterId,
            state.operatorCustomerId,
            state.salespersonId,
            quoteTotal(state.quote),
            orderGiftCardData(state, cart),
          );
          const created = z
            .object({
              order: z.union([
                z.string().regex(/^[1-9]\d{0,19}$/),
                z.number().int().positive().safe(),
              ]),
              method: z.unknown(),
              isValid: z.unknown(),
              name: z.unknown(),
            })
            .passthrough()
            .refine((value) => ['method', 'isValid', 'name'].every((key) => key in value))
            .safeParse(await gateway.api('pos/order', payload, auth));
          if (!created.success)
            // Legacy: a 200 without these keys raises KeyError (unhandled 500). The order may exist.
            throw new CheckoutGatewayError(
              'CHECKOUT_OUTCOME_UNCERTAIN',
              'The checkout service did not return the created order. Review recent orders before retrying.',
              true,
            );
          const orderId = String(created.data.order),
            confirmation = confirmationPayload(
              created.data.order,
              created.data.method,
              created.data.isValid,
              created.data.name,
              c.storeId,
            );
          const checkpoint: CheckoutState = {
            ...state,
            orderId,
            orderSubmissionOperationId: input.operationId,
            phase: 'order-created',
            paymentConfirmation: confirmation,
            confirmationPhase: 'not-dispatched',
          };
          // A process crash after this point retains the created order identity. It
          // never reissues pos/order or silently treats an unconfirmed call as paid.
          await repository.checkpoint(checkpoint, input.operationId);
          if (approval) await options.discounts!.record(checkpoint, orderId, approval);
          await options.recordLineSalespersons?.(checkpoint, orderId);
          const dispatching: CheckoutState = { ...checkpoint, confirmationPhase: 'dispatching' };
          await repository.checkpoint(dispatching, input.operationId);
          try {
            await gateway.confirm(confirmation, auth);
          } catch (error) {
            // Legacy generates the invoice number before checking the confirmation (2799-2809).
            if (error instanceof CheckoutGatewayError && !error.uncertain)
              await options.finalizeOrder(dispatching, orderId, { confirmed: false });
            throw error;
          }
          const acknowledged: CheckoutState = { ...dispatching, confirmationPhase: 'acknowledged' };
          await repository.checkpoint(acknowledged, input.operationId);
          const completed = await completeOrder(acknowledged, orderId);
          if (!payment) return completed;
          // The order exists now; a payment rejection must not fail the order operation. The
          // operator sees it and continues on the order's payment panel, as legacy shows the toast.
          try {
            const started = await options.startPayment!(user, storeId, orderId, payment);
            return { ...completed, result: { ...completed.result, payment: started } };
          } catch (error) {
            return {
              ...completed,
              result: {
                ...completed.result,
                paymentError:
                  error instanceof AppError
                    ? { code: error.code, message: error.message, status: error.status }
                    : {
                        code: 'PAYMENT_OUTCOME_UNCERTAIN',
                        message: 'The payment outcome needs review. Check it on the order.',
                        status: 502,
                      },
              },
            };
          }
        },
      );
    },
    finalize(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'order.finalize', {}, async (state) => {
        if (
          state.phase !== 'order-created' ||
          state.confirmationPhase !== 'acknowledged' ||
          !state.orderId
        )
          throw new AppError(
            409,
            'ORDER_FINALIZATION_REVIEW_REQUIRED',
            'Order confirmation must be verified before finalizing this sale.',
          );
        return completeOrder(state, state.orderId);
      });
    },
    async reconcileConfirmation(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
    ): Promise<MutationReply> {
      requireStore(user, storeId);
      const initial = await get(user, storeId, id);
      await options.assertCheckIn(user.id, storeId, initial.counterId);
      if (!options.verifyCreatedOrder || !options.finalizeOrder)
        throw new AppError(
          503,
          'CHECKOUT_CONFIRMATION_RECOVERY_UNAVAILABLE',
          'Authoritative confirmation recovery is not configured.',
        );
      const reservation = await repository.begin(
        user.id,
        storeId,
        id,
        input,
        operationHash(
          'order.confirmation.reconcile',
          {},
          environment.hs256 || environment.hs512 || '',
        ),
        { leaseId: crypto.randomUUID(), now: now() },
      );
      if (reservation.replay) {
        if (!reservation.receipt.result)
          return {
            status:
              reservation.receipt.status === 'succeeded' ? 'uncertain' : reservation.receipt.status,
            state: reservation.state,
            operationId: input.operationId,
            errorCode: reservation.receipt.errorCode,
          };
        if (!reservation.state.orderId)
          throw new AppError(409, 'CHECKOUT_ORDER_REQUIRED', 'No saved order can be reconciled.');
        await options.verifyCreatedOrder(reservation.state, reservation.state.orderId);
        const cached = reservation.receipt.result;
        const settlement = options.prepaidSettlement
          ? await options.prepaidSettlement(reservation.state)
          : null;
        return {
          status: 'succeeded' as const,
          ...cached,
          result: {
            ...cached.result,
            settlement,
            paymentStatus: settlement ? 'paid' : 'pending',
          },
        };
      }
      try {
        const orderId = reservation.state.orderId!;
        // This is a writer proof read only. Never call pos/order or confirm here,
        // including after a worker dies and its fenced lease is reclaimed.
        await options.verifyCreatedOrder(reservation.state, orderId);
        const acknowledged: CheckoutState = {
          ...reservation.state,
          phase: 'order-created',
          confirmationPhase: 'acknowledged',
        };
        await repository.checkpoint(acknowledged, input.operationId);
        const outcome = await completeOrder(acknowledged, orderId);
        return {
          status: 'succeeded' as const,
          ...(await repository.finish(outcome.state, input.operationId, outcome.result)),
        };
      } catch (error) {
        await repository.fail(
          reservation.state,
          input.operationId,
          !(error instanceof AppError),
          error instanceof AppError ? error.code : 'CHECKOUT_CONFIRMATION_RECOVERY_UNCERTAIN',
        );
        throw error instanceof AppError
          ? error
          : new AppError(
              503,
              'CHECKOUT_CONFIRMATION_RECOVERY_UNCERTAIN',
              'Confirmation recovery was interrupted. Keep this order reference and check its status.',
            );
      }
    },
    async operation(user: Principal, storeId: string, id: string, operationId: string) {
      requireStore(user, storeId);
      const receipt = await repository.operation(user.id, storeId, id, operationId);
      if (!receipt)
        throw new AppError(404, 'OPERATION_NOT_FOUND', 'Checkout operation was not found.');
      if (receipt.result?.result.settlement) {
        const state = await get(user, storeId, id),
          settlement = options.prepaidSettlement ? await options.prepaidSettlement(state) : null;
        return {
          status: receipt.status,
          ...publicMutation(
            {
              ...receipt.result,
              result: {
                ...receipt.result.result,
                settlement,
                paymentStatus: settlement ? 'paid' : 'pending',
              },
            },
            options.cashbackCreditMessage,
          ),
        };
      }
      return receipt.result
        ? {
            status: receipt.status,
            ...publicMutation(receipt.result, options.cashbackCreditMessage),
          }
        : { status: receipt.status, operationId: receipt.id, errorCode: receipt.errorCode };
    },
  };
}
