import { z } from 'zod';
import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import {
  addCartPayload,
  deleteCartPayload,
  setCartPayload,
  type CartContext,
} from '../upstream.js';
import {
  cartSchema,
  type CheckoutRepository,
  type CheckoutState,
  checkoutSubject,
  type MutationInput,
  type PrepaidSettlement,
} from './contracts.js';
import { CheckoutGatewayError, type CheckoutEnvironment, type CheckoutGateway } from './gateway.js';
import { issueCustomerToken, operationHash } from './crypto.js';
import { sameCustomerContact, type CustomerContactBinding } from './customer-contact-authority.js';
import {
  checkoutCustomerOtpScope,
  withCustomerOtpView,
  type CustomerVerificationClient,
} from './customer-verification.js';
import { cartCopyHash, OrderCopyPreflightError } from './order-copy/domain.js';
import type { DiscountApprovals } from './discounts/contracts.js';
import type { CustomerRegistrations } from './customers/contracts.js';
import type { PaymentInput } from './payments/contracts.js';
import type { CustomerLookupService } from './customers/lookup.js';
import { giftCardOperations, giftCardRows, withGiftCardDates } from './gift-card-cart.js';
import { clearCartPayload, readCartPayload, wireId, type Payload } from './payloads.js';
import { publicCart } from './service-public.js';

export interface CheckoutServiceOptions {
  cashbackCreditMessage?: string;
  verifyCopyCancellationClear?: (state: CheckoutState) => Promise<void>;
  orderCopyHashSecret?: string;
  assertCheckIn(userId: string, storeId: string, counterId?: string): Promise<void>;
  migrationV2: boolean;
  now?: () => number;
  prepaidSettlement?: (state: CheckoutState) => Promise<PrepaidSettlement | null>;
  /**
   * Writer read that the created order exists for this sale (store, counter). Used only by the
   * operator-driven confirmation reconciliation; it never re-sends pos/order or the confirmation.
   */
  verifyCreatedOrder?(state: CheckoutState, orderId: string): Promise<void>;
  /**
   * Legacy normal path (`create_order.html:6177-7239`): the operator confirms the payment form, then
   * `ajax-order` creates the order and `ajax-transaction-upload` starts that payment.
   */
  startPayment?(
    user: Principal,
    storeId: string,
    orderId: string,
    input: PaymentInput,
  ): Promise<unknown>;
  /** `has_products.salesperson_id` per line, right after pos/order (order/views.py:2779-2795). */
  recordLineSalespersons?(state: CheckoutState, orderId: string): Promise<void>;
  registrations?: CustomerRegistrations;
  /** Legacy `ajax_user_details` via API-v2 `check-user-exclusive` (users/views.py:612-664). */
  customerLookup?: CustomerLookupService;
  customerOtp?: CustomerVerificationClient;
  discounts?: DiscountApprovals;
  businessTimezone?: string;
  finalizeOrder?(
    state: CheckoutState,
    orderId: string,
    outcome?: { confirmed: boolean },
  ): Promise<{ transactionId: string; invoice: string | null }>;
}
export type MutationReply =
  | { status: 'succeeded'; state: CheckoutState; result: Payload }
  | {
      status: 'inflight' | 'uncertain' | 'rejected';
      state: CheckoutState;
      operationId: string;
      errorCode: string | null;
    };

/**
 * The state shared by every checkout operation: the checkout read, cart access, the idempotent
 * mutation runner and the cart helpers. The operation groups in `service-*.ts` build on it.
 */
export function checkoutServiceCore(
  repository: CheckoutRepository,
  gateway: CheckoutGateway,
  environment: CheckoutEnvironment,
  options: CheckoutServiceOptions,
) {
  const now = options.now || Date.now;
  const cartPath = options.migrationV2 ? 'cart' : 'pos/cart';
  async function get(user: Principal, storeId: string, id: string) {
    requireStore(user, storeId);
    const state = await repository.get(user.id, storeId, id);
    if (!state) throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'Checkout was not found.');
    if (
      state.createdAt + 12 * 3600000 < now() &&
      !state.orderId &&
      state.phase !== 'submitted' &&
      state.phase !== 'cleared' &&
      state.phase !== 'uncertain'
    )
      throw new AppError(410, 'CHECKOUT_EXPIRED', 'This checkout expired. Start a new sale.');
    if (
      options.customerOtp &&
      state.customerId &&
      state.verificationChallenge?.requestOperationId &&
      ['open', 'quoted'].includes(state.phase)
    ) {
      try {
        const view = await options.customerOtp.read(
          user,
          checkoutCustomerOtpScope(state),
          state.verificationChallenge.id,
        );
        const refreshed = withCustomerOtpView(state, view);
        return {
          ...refreshed,
          verifiedCustomerUntil:
            state.verifiedCustomerUntil && view.verifiedUntil === state.verifiedCustomerUntil
              ? state.verifiedCustomerUntil
              : null,
          verifiedCustomerContact:
            state.verifiedCustomerUntil && view.verifiedUntil === state.verifiedCustomerUntil
              ? state.verifiedCustomerContact
              : null,
        };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        // Scope/contact/actor revocation invalidates only an unspent proof. Read
        // failures never erase the original durable challenge or payment state.
        return {
          ...state,
          verifiedCustomerUntil: null,
          verifiedCustomerContact: null,
          verificationChallenge: {
            ...state.verificationChallenge,
            sent: false,
            deliveryStatus:
              error.status === 404
                ? state.verificationChallenge.deliveryStatus
                : ('rejected' as const),
          },
        };
      }
    }
    if (state.customerId && (state.verifiedCustomerUntil || state.verificationChallenge?.sent)) {
      let contact: CustomerContactBinding | null = null;
      try {
        contact = await repository.customerContact(state.customerId);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'CHECKOUT_CUSTOMER_UNAVAILABLE')
          throw error;
      }
      const verifiedCurrent = sameCustomerContact(contact, state.verifiedCustomerContact),
        challengeCurrent = sameCustomerContact(contact, state.verificationChallenge?.contact);
      return {
        ...state,
        verifiedCustomerUntil: verifiedCurrent ? state.verifiedCustomerUntil : null,
        verifiedCustomerContact: verifiedCurrent ? state.verifiedCustomerContact : null,
        verificationChallenge: state.verificationChallenge
          ? {
              ...state.verificationChallenge,
              sent: state.verificationChallenge.sent && challengeCurrent,
            }
          : null,
      };
    }
    return state;
  }
  function context(state: CheckoutState): CartContext {
    return {
      storeId: wireId(state.storeId),
      tabId: state.tabId,
      endUser: state.customerId !== null,
    };
  }
  async function token(state: CheckoutState) {
    const identity = await repository.customer(checkoutSubject(state), 'writer');
    if (!identity)
      throw new AppError(
        409,
        'CHECKOUT_CUSTOMER_UNAVAILABLE',
        'The checkout account was not found.',
      );
    return issueCustomerToken(identity, environment, now());
  }
  async function readCart(state: CheckoutState, auth?: string) {
    const value = await gateway.api(
      cartPath,
      readCartPayload(context(state)),
      auth || (await token(state)),
    );
    // CreateOrderView.get (order/views.py:1546-1552): an upstream `title` is shown as the error;
    // an empty cart response is "We have a little problem, please try again later !".
    const titled = z
      .object({ title: z.string().min(1).max(500) })
      .passthrough()
      .safeParse(value);
    if (titled.success && !cartSchema.safeParse(value).success)
      throw new AppError(502, 'CART_UNAVAILABLE', titled.data.title);
    const cart = cartSchema.safeParse(value);
    if (!cart.success)
      throw new AppError(
        502,
        'CART_UNAVAILABLE',
        'We have a little problem, please try again later !',
      );
    return cart.data;
  }
  async function requireVerified(user: Principal, state: CheckoutState) {
    const customerId = state.customerId,
      contact = state.verifiedCustomerContact,
      expiresAt = state.verifiedCustomerUntil;
    if (
      !customerId ||
      !contact ||
      !expiresAt ||
      expiresAt <= now() ||
      !sameCustomerContact(contact, await repository.customerContact(customerId))
    )
      throw new AppError(
        403,
        'CUSTOMER_VERIFICATION_REQUIRED',
        'Verify this customer before applying these benefits.',
      );
    if (
      options.customerOtp &&
      state.verificationChallenge?.requestOperationId &&
      ['open', 'quoted', 'order-created'].includes(state.phase)
    ) {
      const view = await options.customerOtp.read(
        user,
        checkoutCustomerOtpScope(state),
        state.verificationChallenge.id,
      );
      if (view.verifiedUntil !== expiresAt || !sameCustomerContact(view.contact, contact))
        throw new AppError(
          403,
          'CUSTOMER_VERIFICATION_REQUIRED',
          'Verify this customer before applying these benefits.',
        );
    }
    return { customerId, contact, expiresAt };
  }
  function editable(state: CheckoutState) {
    if (['order-created', 'submitted', 'cleared'].includes(state.phase))
      throw new AppError(
        409,
        'CHECKOUT_ALREADY_SUBMITTED',
        'This sale already has an order. Open its order details.',
      );
  }
  async function mutate(
    user: Principal,
    storeId: string,
    id: string,
    input: MutationInput,
    kind: string,
    payload: unknown,
    action: (state: CheckoutState) => Promise<{ state: CheckoutState; result: Payload }>,
  ): Promise<MutationReply> {
    requireStore(user, storeId);
    const initial = await get(user, storeId, id);
    await options.assertCheckIn(user.id, storeId, initial.counterId);
    if (
      initial.orderCopy &&
      initial.orderCopy.status !== 'acknowledged' &&
      !(
        initial.orderCopy.status === 'cancelled-unsent' &&
        ['cart.clear', 'customer.detach'].includes(kind)
      )
    )
      throw new AppError(
        409,
        'ORDER_COPY_REVIEW_REQUIRED',
        'Reconcile and acknowledge the copied cart before changing, quoting or submitting this sale.',
      );
    if (initial.orderCopy?.status === 'cancelled-unsent') {
      if (!options.verifyCopyCancellationClear)
        throw new AppError(
          409,
          'ORDER_COPY_CANCELLATION_UNCONFIRMED',
          'Refresh the original cancellation before clearing the saved sale.',
        );
      await options.verifyCopyCancellationClear(initial);
    }
    if (initial.draftImport?.status === 'pending' && kind !== 'cart.draft.initialize')
      throw new AppError(
        409,
        'CHECKOUT_DRAFT_NOT_INITIALIZED',
        'Finish loading the saved sale before changing or quoting this checkout.',
      );
    const reservation = await repository.begin(
      user.id,
      storeId,
      id,
      input,
      operationHash(kind, payload, environment.hs256 || environment.hs512 || ''),
    );
    if (reservation.replay) {
      if (reservation.receipt.result) {
        const cached = reservation.receipt.result;
        if (['order.create', 'order.finalize'].includes(kind) && cached.result.settlement) {
          const settlement = options.prepaidSettlement
            ? await options.prepaidSettlement(reservation.state)
            : null;
          return {
            status: 'succeeded',
            ...cached,
            result: {
              ...cached.result,
              settlement,
              paymentStatus: settlement ? 'paid' : 'pending',
            },
          };
        }
        return { status: 'succeeded', ...cached };
      }
      return {
        status:
          reservation.receipt.status === 'succeeded' ? 'uncertain' : reservation.receipt.status,
        state: reservation.state,
        operationId: input.operationId,
        errorCode: reservation.receipt.errorCode,
      };
    }
    try {
      // A submitted or cleared sale released the customer's cart lease when it finished; an
      // action on it (a stale window, a retry) is refused below and must not take the lease back,
      // or the customer cannot start another checkout for 12 hours (W26, UAT).
      if (
        reservation.state.customerId &&
        reservation.state.phase !== 'submitted' &&
        reservation.state.phase !== 'cleared'
      )
        await repository.acquireCustomer(id, reservation.state.customerId);
      const outcome = await action(reservation.state);
      return {
        status: 'succeeded',
        ...(await repository.finish(outcome.state, input.operationId, outcome.result)),
      };
    } catch (error) {
      const uncertain =
        error instanceof CheckoutGatewayError ? error.uncertain : !(error instanceof AppError);
      await repository.fail(
        reservation.state,
        input.operationId,
        uncertain,
        error instanceof AppError ? error.code : 'CHECKOUT_OUTCOME_UNCERTAIN',
      );
      throw error instanceof AppError
        ? error
        : new AppError(
            502,
            'CHECKOUT_OUTCOME_UNCERTAIN',
            'The checkout outcome needs review. Do not repeat this operation.',
          );
    }
  }
  async function cartMutation(state: CheckoutState, path: string, payload: Payload, auth?: string) {
    editable(state);
    const cart = cartSchema.parse(await gateway.api(path, payload, auth || (await token(state))));
    return {
      state: {
        ...state,
        cart,
        ...withGiftCardDates(
          state,
          cart,
          now(),
          environment.giftCardExpiryDays,
          options.businessTimezone,
        ),
        quote: null,
        phase: 'open' as const,
        orderCopy: state.orderCopy?.status === 'acknowledged' ? null : state.orderCopy,
      },
      result: { cart: publicCart(cart) },
    };
  }
  const gifts = giftCardOperations(
    repository,
    environment,
    { read: readCart, change: cartMutation, token },
    cartPath,
  );
  async function completeOrder(state: CheckoutState, orderId: string) {
    if (!options.finalizeOrder)
      throw new AppError(
        503,
        'ORDER_FINALIZER_UNAVAILABLE',
        'Order finalization is not configured.',
      );
    const finalized = await options.finalizeOrder(state, orderId);
    if (state.customerId) await repository.releaseCustomer(state.id, state.customerId);
    const submitted = { ...state, phase: 'submitted' as const },
      settlement = options.prepaidSettlement ? await options.prepaidSettlement(submitted) : null;
    return {
      state: submitted,
      result: { orderId, ...finalized, paymentStatus: settlement ? 'paid' : 'pending', settlement },
    };
  }
  async function changeLine(
    state: CheckoutState,
    operationId: string,
    productId: string,
    quantity: number,
    expectedCopyHash?: string,
  ) {
    editable(state);
    const auth = await token(state),
      cart = await readCart(state, auth),
      items = cart.products.items;
    if (
      expectedCopyHash &&
      (!options.orderCopyHashSecret ||
        cartCopyHash(cart, options.orderCopyHashSecret) !== expectedCopyHash)
    )
      throw new OrderCopyPreflightError();
    const giftItems = giftCardRows(cart).filter((item) => item.prod_id === productId);
    if (giftItems.length) {
      const product =
        quantity > giftItems.length
          ? await repository.cartProduct(productId)
          : { type: 8, barcode: null };
      if (!product || product.type !== 8)
        throw new AppError(
          422,
          'GIFT_CARD_PRODUCT_REQUIRED',
          'The gift card product is unavailable.',
        );
      return gifts.setQuantity(state, operationId, productId, quantity, product, cart, auth);
    }
    const existing = items.find((item) => String(item.prod_id) === productId);
    if (quantity === 0)
      return cartMutation(
        state,
        cartPath,
        deleteCartPayload(context(state), wireId(productId)),
        auth,
      );
    if (existing)
      return cartMutation(
        state,
        cartPath,
        setCartPayload(context(state), wireId(productId), quantity),
        auth,
      );
    const product = await repository.cartProduct(productId);
    if (!product?.barcode)
      throw new AppError(422, 'PRODUCT_BARCODE_MISSING', 'This product has no barcode.');
    if (product.type === 8)
      return gifts.setQuantity(state, operationId, productId, quantity, product, cart, auth);
    const added = await cartMutation(
      state,
      'pos/product',
      addCartPayload(context(state), product.barcode),
      auth,
    );
    if (quantity !== 1)
      return cartMutation(
        added.state,
        cartPath,
        setCartPayload(context(state), wireId(productId), quantity),
        auth,
      );
    return added;
  }
  async function clearCheckout(
    state: CheckoutState,
    operationId: string,
    reason: 'cart-clear' | 'customer-detach' = 'cart-clear',
  ) {
    if (state.orderId)
      throw new AppError(
        409,
        'CHECKOUT_ORDER_EXISTS',
        'An order already exists for this checkout. Review its order details.',
      );
    const registrationCleared = options.registrations
      ? await options.registrations.cancel(state)
      : true;
    const cleared = await cartMutation(
      state,
      cartPath,
      clearCartPayload(context(state), await readCart(state)),
    );
    const empty = (cart: CheckoutState['cart']) =>
      cart !== null &&
      cart.products.items.length === 0 &&
      (cart.giftvouchers?.items.length ?? 0) === 0;
    if (!empty(cleared.state.cart))
      throw new CheckoutGatewayError(
        'CHECKOUT_CART_CLEAR_UNCONFIRMED',
        'The cleared cart was not confirmed. Check its status before continuing.',
        true,
      );
    // Retain confirmed progress if the separate actor-tab cleanup is interrupted.
    await repository.checkpoint(cleared.state, operationId);
    let next: CheckoutState = {
      ...cleared.state,
      customerId: null,
      verifiedCustomerUntil: null,
      verifiedCustomerContact: null,
      verificationChallenge: null,
      salespersonId: null,
      lineSalespersons: {},
      settlementNote: null,
      discountMetadata: { pg: null, store: null },
      giftCards: {},
      giftCardDates: {},
      giftCardValues: {},
      registrationId: registrationCleared ? null : state.registrationId,
    };
    if (state.customerId) {
      const actor = await cartMutation(
        next,
        cartPath,
        clearCartPayload(context(next), await readCart(next)),
      );
      next = actor.state;
      if (!empty(next.cart))
        throw new CheckoutGatewayError(
          'CHECKOUT_CART_CLEAR_UNCONFIRMED',
          'The walk-in cart was not confirmed empty. Check its status before continuing.',
          true,
        );
    }
    const clearance =
      state.draftId && state.draftVersion !== null && state.draftVersion !== undefined
        ? {
            status: 'cleared' as const,
            checkoutId: state.id,
            operationId,
            operatorId: state.operatorId,
            storeId: state.storeId,
            counterId: state.counterId,
            draftId: state.draftId,
            draftVersion: state.draftVersion,
            reason,
            clearedAt: now(),
          }
        : null;
    next = { ...next, phase: 'cleared', lastClear: clearance };
    // The repository commits terminal evidence and removal of every owned
    // customer/gift-card lease together. This never creates a paid receipt.
    await repository.checkpoint(next, operationId);
    return {
      state: next,
      result: {
        cart: publicCart(next.cart),
        customerDetached: state.customerId !== null,
        cleared: clearance,
      },
    };
  }
  return {
    repository,
    gateway,
    environment,
    options,
    now,
    cartPath,
    get,
    context,
    token,
    readCart,
    requireVerified,
    editable,
    mutate,
    cartMutation,
    gifts,
    completeOrder,
    changeLine,
    clearCheckout,
  };
}
export type CheckoutServiceCore = ReturnType<typeof checkoutServiceCore>;
