import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { Principal } from '../../domain/access.js';
import { requireRole, requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import {
  addCartPayload,
  deleteCartPayload,
  processPayload,
  setCartPayload,
  validatePayload,
  type CartContext,
} from '../upstream.js';
import {
  cartSchema,
  draftLineItemsSchema,
  orderNotificationsSchema,
  type DraftLineItem,
  type Cart,
  type CheckoutRepository,
  type CheckoutState,
  type MutationInput,
  type MutationResult,
  type PrepaidSettlement,
} from './contracts.js';
import { CheckoutGatewayError, type CheckoutEnvironment, type CheckoutGateway } from './gateway.js';
import { assertCheckoutProjectionReady } from './projection.js';
import { assertRefundAllocationReady } from './refund-allocation.js';
import { assertGiftCardContract } from './gift-card-issuance.js';
import { issueCustomerToken, newTabId, operationHash } from './crypto.js';
import { sameCustomerContact, type CustomerContactBinding } from './customer-contact-authority.js';
import {
  assertCustomerConsentReady,
  customerConsentContract,
  type CustomerConsent,
} from './customer-consent.js';
import {
  checkoutCustomerOtpScope,
  customerVerificationOperation,
  withCustomerOtpView,
  type CustomerVerificationClient,
  type CustomerVerificationEvidence,
} from './customer-verification.js';
import { validateGiftCardSerial } from './gift-cards.js';
import { Temporal } from '@js-temporal/polyfill';
import { amount, minorUnits } from '../../domain/money.js';
import {
  createSettlementNote,
  publicSettlementNote,
  settlementMessageSchema,
} from './settlement-note.js';
import type { DiscountApprovals } from './discounts/contracts.js';
import type { CustomerRegistrations, RegistrationDetails } from './customers/contracts.js';
import { discountMetadataSchema, discountTerms } from './discounts/policy.js';
import {
  assertGiftCardValues,
  giftCardOperations,
  giftCardRows,
  withGiftCardDates,
} from './gift-card-cart.js';
import {
  clearCartPayload,
  confirmationPayload,
  couponPayload,
  exclusivePayload,
  giftVoucherPayload,
  orderPayload,
  pgDiscountPayload,
  readCartPayload,
  removeBenefitPayload,
  storeDiscountPayload,
  syncCartPayload,
  walletPayload,
  wireId,
  type Payload,
} from './payloads.js';

export interface CheckoutServiceOptions {
  assertCheckIn(userId: string, storeId: string, counterId?: string): Promise<void>;
  migrationV2: boolean;
  now?: () => number;
  prepaidSettlement?: (state: CheckoutState) => Promise<PrepaidSettlement | null>;
  verifyProjection?(state: CheckoutState, orderId: string): Promise<void>;
  verifyRefundAllocations?(state: CheckoutState, orderId: string): Promise<void>;
  registrations?: CustomerRegistrations;
  customerOtp?: CustomerVerificationClient;
  discounts?: DiscountApprovals;
  businessTimezone?: string;
  finalizeOrder?(
    state: CheckoutState,
    orderId: string,
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

export function checkoutService(
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
    const identity = await repository.customer(
      state.customerId || state.operatorCustomerId,
      'writer',
    );
    if (!identity)
      throw new AppError(
        409,
        'CHECKOUT_CUSTOMER_UNAVAILABLE',
        'The checkout account was not found.',
      );
    return issueCustomerToken(identity, environment, now());
  }
  async function readCart(state: CheckoutState, auth?: string) {
    return cartSchema.parse(
      await gateway.api(cartPath, readCartPayload(context(state)), auth || (await token(state))),
    );
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
  async function requireCurrentSpendingAuthority(
    user: Principal,
    state: CheckoutState,
    cart: Cart,
  ) {
    const meta = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(cart.meta);
    let spending = false;
    for (const item of meta.items) {
      if (item.name === 'coupon' && item.coupon !== undefined && item.coupon !== null) {
        const code = z.string().min(1).max(100).safeParse(item.coupon);
        if (!code.success)
          throw new AppError(
            502,
            'CHECKOUT_BENEFITS_INVALID',
            'The authoritative benefit allocation could not be verified.',
          );
        if (await repository.isEmployeeCoupon(code.data)) spending = true;
      }
      for (const key of [
        'used_tss_money',
        'used_tss_points',
        'used_reward_points',
        'gift_voucher_value',
      ]) {
        const raw = item[key];
        if (raw === undefined || raw === null) continue;
        const value = z
          .union([z.number().finite().nonnegative(), z.string().regex(/^\d+(?:\.\d+)?$/)])
          .safeParse(raw);
        if (!value.success)
          throw new AppError(
            502,
            'CHECKOUT_BENEFITS_INVALID',
            'The authoritative benefit allocation could not be verified.',
          );
        if (new Decimal(value.data).gt(0)) spending = true;
      }
    }
    return spending ? requireVerified(user, state) : null;
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
      if (reservation.state.customerId)
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
  ) {
    editable(state);
    const auth = await token(state),
      cart = await readCart(state, auth),
      items = cart.products.items;
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
      orderCustomerConsent: null,
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
    async create(
      user: Principal,
      storeId: string,
      counterId: string,
      draftId: string = crypto.randomUUID(),
      draft?: { version: number; lineItems: DraftLineItem[] },
    ) {
      requireStore(user, storeId);
      await options.assertCheckIn(user.id, storeId, counterId);
      if (!(await repository.counter(storeId, counterId)))
        throw new AppError(409, 'COUNTER_UNAVAILABLE', 'Select an active counter at this store.');
      const operator = await repository.operatorIdentity(user.id);
      if (!operator)
        throw new AppError(
          409,
          'OPERATOR_CUSTOMER_MAPPING_MISSING',
          'Your operator account is not connected to checkout.',
        );
      issueCustomerToken(operator, environment, now());
      const timestamp = now();
      const state: CheckoutState = {
        id: crypto.randomUUID(),
        draftId,
        orderNotifications: { sendSms: true, npsFeedback: false },
        draftVersion: draft?.version ?? null,
        draftImport: draft
          ? {
              lineItems: draftLineItemsSchema
                .parse(draft.lineItems)
                .sort((a, b) =>
                  a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0,
                ),
              completedProductIds: [],
              status: draft.lineItems.length ? 'pending' : 'complete',
            }
          : null,
        operatorId: user.id,
        operatorCustomerId: operator.id,
        storeId,
        counterId,
        tabId: newTabId(),
        customerId: null,
        verifiedCustomerUntil: null,
        verifiedCustomerContact: null,
        orderCustomerConsent: null,
        verificationChallenge: null,
        version: 0,
        phase: 'open',
        cart: null,
        quote: null,
        orderId: null,
        orderSubmissionOperationId: null,
        paymentConfirmation: null,
        confirmationPhase: null,
        salespersonId: null,
        lineSalespersons: {},
        settlementNote: null,
        giftCards: {},
        giftCardDates: {},
        giftCardValues: {},
        discountMetadata: { pg: null, store: null },
        busyOperationId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      return publicState(await repository.create(state));
    },
    async read(user: Principal, storeId: string, id: string) {
      const state = await get(user, storeId, id);
      const registration = options.registrations ? await options.registrations.read(state) : null;
      const registrationRequest =
        state.registrationId && !state.orderId
          ? await repository.operation(user.id, storeId, id, state.registrationId)
          : null;
      const registrationRequestRecovery = Boolean(
        registration &&
        registrationRequest &&
        registrationRequest.status !== 'succeeded' &&
        !registrationRequest.result,
      );
      if (state.phase === 'submitted')
        return {
          ...publicState(state),
          registration,
          registrationRequestRecovery,
          settlement: options.prepaidSettlement ? await options.prepaidSettlement(state) : null,
        };
      if (
        state.phase === 'uncertain' ||
        state.phase === 'cleared' ||
        state.busyOperationId ||
        state.draftImport?.status === 'pending'
      )
        return {
          ...publicState(state),
          registration,
          registrationRequestRecovery,
          settlement: null,
        };
      return {
        ...publicState(state),
        registration,
        registrationRequestRecovery,
        settlement: null,
        cart: publicCart(await readCart(state)),
      };
    },
    orderNotifications(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      preferences: z.infer<typeof orderNotificationsSchema>,
    ) {
      const validated = orderNotificationsSchema.parse(preferences);
      return mutate(user, storeId, id, input, 'order.notifications', validated, async (state) => {
        editable(state);
        return {
          state: { ...state, orderNotifications: validated },
          result: { orderNotifications: validated },
        };
      });
    },
    async lookup(user: Principal, storeId: string, counterId: string, query: string) {
      requireStore(user, storeId);
      await options.assertCheckIn(user.id, storeId, counterId);
      return (await repository.findCustomer(query))
        .filter((customer) => customer.active)
        .map(({ id, firstName, lastName, email, telephone }) => ({
          id,
          firstName,
          lastName,
          email,
          telephone,
        }));
    },
    attachCustomer(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      customerId: string,
    ) {
      return mutate(user, storeId, id, input, 'customer.attach', { customerId }, async (state) => {
        editable(state);
        const customer = await repository.customer(customerId, 'writer');
        if (!customer || !customer.active)
          throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer was not found.');
        if (state.customerId && state.customerId !== customerId)
          throw new AppError(
            409,
            'CUSTOMER_ALREADY_ATTACHED',
            'Start another sale to change the customer.',
          );
        if (state.customerId === customerId)
          return {
            state,
            result: {
              customer: {
                id: customer.id,
                firstName: customer.firstName,
                lastName: customer.lastName,
              },
              cart: state.cart ? publicCart(state.cart) : null,
            },
          };
        await repository.acquireCustomer(id, customerId);
        try {
          const oldCart = await readCart(state);
          const targetToken = issueCustomerToken(customer, environment, now());
          await gateway.api(
            options.migrationV2 ? 'syncart' : 'pos/syncart',
            syncCartPayload(context(state), targetToken, oldCart),
          );
          const verifiedUntil = options.registrations
            ? await options.registrations.verifiedCustomerUntil(state, customer)
            : null;
          const next = {
            ...state,
            customerId,
            verifiedCustomerUntil: verifiedUntil,
            verifiedCustomerContact: verifiedUntil
              ? await repository.customerContact(customerId)
              : null,
            verificationChallenge: null,
            cart: null,
            quote: null,
            phase: 'open' as const,
          };
          await repository.checkpoint(next, input.operationId);
          try {
            await gateway.api(
              cartPath,
              clearCartPayload(context(state), oldCart),
              await token(state),
            );
          } catch {
            /* The bound customer cart is authoritative; actor-cart cleanup never gates a financial success. */
          }
          const cart = await readCart(next);
          return {
            state: { ...next, cart },
            result: {
              customer: {
                id: customer.id,
                firstName: customer.firstName,
                lastName: customer.lastName,
              },
              cart: publicCart(cart),
            },
          };
        } catch (error) {
          if (
            error instanceof AppError &&
            !(error instanceof CheckoutGatewayError && error.uncertain)
          )
            await repository.releaseCustomer(id, customerId);
          throw error;
        }
      });
    },
    requestRegistration(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      details: RegistrationDetails,
    ) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'customer.registration.request',
        details,
        async (state) => {
          editable(state);
          if (state.customerId)
            throw new AppError(
              409,
              'CUSTOMER_ALREADY_ATTACHED',
              'Detach the existing customer before registration.',
            );
          if (!options.registrations)
            throw new AppError(
              503,
              'CUSTOMER_REGISTRATION_UNAVAILABLE',
              'Customer registration is not configured.',
            );
          if (!environment.hs512 || environment.hs512.length < 32)
            throw new AppError(
              503,
              'CUSTOMER_REGISTRATION_IDENTITY_UNAVAILABLE',
              'New-customer identity signing is not configured.',
            );
          const registration = await options.registrations.request(
              state,
              input.operationId,
              details,
            ),
            next = { ...state, registrationId: registration.id };
          await repository.checkpoint(next, input.operationId);
          return { state: next, result: { registration } };
        },
      );
    },
    verifyRegistration(
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
        'customer.registration.verify',
        { code },
        async (state) => {
          editable(state);
          if (!options.registrations)
            throw new AppError(
              503,
              'CUSTOMER_REGISTRATION_UNAVAILABLE',
              'Customer registration is not configured.',
            );
          return {
            state,
            result: { registration: await options.registrations.verify(state, code) },
          };
        },
      );
    },
    async recoverRegistrationRequest(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
    ): Promise<MutationReply> {
      requireStore(user, storeId);
      const initial = await get(user, storeId, id);
      await options.assertCheckIn(user.id, storeId, initial.counterId);
      if (!options.registrations)
        throw new AppError(
          503,
          'CUSTOMER_REGISTRATION_UNAVAILABLE',
          'Customer registration is not configured.',
        );
      const reservation = await repository.begin(
        user.id,
        storeId,
        id,
        input,
        operationHash(
          'customer.registration.request.recover',
          {},
          environment.hs256 || environment.hs512 || '',
        ),
        { leaseId: crypto.randomUUID(), now: now(), purpose: 'registration-request' },
      );
      if (reservation.replay) {
        if (reservation.receipt.result)
          return {
            status: 'succeeded',
            state: reservation.state,
            result: { registration: await options.registrations.read(reservation.state) },
          };
        return {
          status:
            reservation.receipt.status === 'succeeded' ? 'uncertain' : reservation.receipt.status,
          state: reservation.state,
          operationId: input.operationId,
          errorCode: reservation.receipt.errorCode,
        };
      }
      try {
        const registration = await options.registrations.read(reservation.state);
        if (!registration || registration.id !== reservation.state.registrationId)
          throw new AppError(
            409,
            'CUSTOMER_REGISTRATION_REQUEST_UNPROVED',
            'The queued registration request could not be proved.',
          );
        // The existing transactional queue is the proof. Never enqueue another
        // message or call registration as part of request recovery.
        const state: CheckoutState = {
          ...reservation.state,
          phase: reservation.state.quote ? 'quoted' : 'open',
        };
        return {
          status: 'succeeded',
          ...(await repository.finish(state, input.operationId, { registration })),
        };
      } catch (error) {
        await repository.fail(
          reservation.state,
          input.operationId,
          !(error instanceof AppError),
          error instanceof AppError ? error.code : 'CUSTOMER_REGISTRATION_REQUEST_UNCERTAIN',
        );
        throw error instanceof AppError
          ? error
          : new AppError(
              503,
              'CUSTOMER_REGISTRATION_REQUEST_UNCERTAIN',
              'Queued registration recovery was interrupted. Keep its reference and check its status.',
            );
      }
    },
    cancelRegistration(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'customer.registration.cancel', {}, async (state) => {
        editable(state);
        if (!options.registrations)
          throw new AppError(
            503,
            'CUSTOMER_REGISTRATION_UNAVAILABLE',
            'Customer registration is not configured.',
          );
        if (!(await options.registrations.cancel(state)))
          throw new AppError(
            409,
            'CUSTOMER_REGISTRATION_REVIEW_REQUIRED',
            'A dispatched registration must be reconciled before it can be closed.',
          );
        return { state: { ...state, registrationId: null }, result: { cancelled: true } };
      });
    },
    resendRegistration(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'customer.registration.resend', {}, async (state) => {
        editable(state);
        if (!options.registrations)
          throw new AppError(
            503,
            'CUSTOMER_REGISTRATION_UNAVAILABLE',
            'Customer registration is not configured.',
          );
        return {
          state,
          result: { registration: await options.registrations.resend(state, input.operationId) },
        };
      });
    },
    registerCustomer(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'customer.registration.create', {}, async (state) => {
        editable(state);
        if (!options.registrations)
          throw new AppError(
            503,
            'CUSTOMER_REGISTRATION_UNAVAILABLE',
            'Customer registration is not configured.',
          );
        return { state, result: { registration: await options.registrations.register(state) } };
      });
    },
    reconcileRegistration(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'customer.registration.reconcile',
        {},
        async (state) => {
          editable(state);
          if (!options.registrations)
            throw new AppError(
              503,
              'CUSTOMER_REGISTRATION_UNAVAILABLE',
              'Customer registration is not configured.',
            );
          return { state, result: { registration: await options.registrations.reconcile(state) } };
        },
      );
    },
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
        if (await repository.isEmployeeCoupon(code)) await requireVerified(user, state);
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
          return cartMutation(state, 'giftvoucher', giftVoucherPayload(context(state), code, pin));
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
          const start = Temporal.PlainDate.from(metadata.startDate),
            end = Temporal.PlainDate.from(metadata.endDate);
          if (start.year < 1 || end.year > 9999 || Temporal.PlainDate.compare(end, start) < 0)
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
                [giftId]: { number, startDate: start.toString(), endDate: end.toString() },
              },
            },
            result: { giftId, number, startDate: start.toString(), endDate: end.toString() },
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
      requireRole(user, options.discounts?.permittedRoles || [1, 2, 3]);
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
            state: {
              ...state,
              ...(productId
                ? { lineSalespersons: { ...state.lineSalespersons, [productId]: salespersonId } }
                : { salespersonId }),
            },
            result: { salespersonId, productId: productId || null },
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
    sendVerification(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'customer.otp.send', {}, async (state) => {
        editable(state);
        if (!state.customerId)
          throw new AppError(409, 'CUSTOMER_REQUIRED', 'Connect a customer first.');
        if (state.verificationChallenge && state.verificationChallenge.lastSentAt + 60000 > now())
          throw new AppError(
            429,
            'CUSTOMER_OTP_SEND_LIMIT',
            'Wait before requesting another customer verification code.',
          );
        const challenge = {
            id: crypto.randomUUID(),
            expiresAt: now() + 5 * 60000,
            attempts: 0,
            lastSentAt: now(),
            sent: false,
            contact: await repository.customerContact(state.customerId),
            requestOperationId: options.customerOtp ? input.operationId : null,
            verifyOperationId: null,
            deliveryStatus: options.customerOtp ? ('pending' as const) : null,
          },
          checkpoint = {
            ...state,
            verificationChallenge: challenge,
            verifiedCustomerUntil: null,
            verifiedCustomerContact: null,
          };
        await repository.checkpoint(checkpoint, input.operationId);
        if (options.customerOtp) {
          const value = await options.customerOtp.request(
            user,
            checkoutCustomerOtpScope(checkpoint),
            challenge.id,
            input.operationId,
            challenge.contact,
          );
          return {
            state: withCustomerOtpView(checkpoint, value),
            result: { queued: true, deliveryStatus: value.status, expiresAt: value.expiresAt },
          };
        }
        const result = z
          .object({ mobile: z.boolean().optional(), email: z.boolean().optional() })
          .passthrough()
          .parse(await gateway.api('omnichannel-sendotp', { user_id: wireId(state.customerId) }));
        if (!result.mobile && !result.email)
          throw new AppError(
            422,
            'OTP_NOT_SENT',
            'The customer verification code could not be sent.',
          );
        if (
          !sameCustomerContact(
            challenge.contact,
            await repository.customerContact(state.customerId),
          )
        )
          throw new AppError(
            409,
            'CUSTOMER_CONTACT_CHANGED',
            'Customer contact changed. Request a new verification code.',
          );
        return {
          state: {
            ...checkpoint,
            verificationChallenge: { ...challenge, sent: true, deliveryStatus: 'sent' },
          },
          result: { sent: true, expiresAt: challenge.expiresAt },
        };
      });
    },
    verify(user: Principal, storeId: string, id: string, input: MutationInput, otp: string) {
      return mutate(user, storeId, id, input, 'customer.otp.verify', { otp }, async (state) => {
        editable(state);
        if (!state.customerId)
          throw new AppError(409, 'CUSTOMER_REQUIRED', 'Connect a customer first.');
        const challenge = state.verificationChallenge;
        if (options.customerOtp) {
          if (!challenge?.requestOperationId || !challenge.contact)
            throw new AppError(
              403,
              'CUSTOMER_OTP_CHALLENGE_REQUIRED',
              'Request a new customer verification code.',
            );
          const latest = await options.customerOtp.read(
            user,
            checkoutCustomerOtpScope(state),
            challenge.id,
          );
          if (!['sent', 'uncertain'].includes(latest.status) || latest.expiresAt <= now())
            throw new AppError(
              403,
              'CUSTOMER_OTP_CHALLENGE_REQUIRED',
              'Wait for delivery or request a new customer verification code.',
            );
          const checkpoint: CheckoutState = {
            ...withCustomerOtpView(state, latest),
            verificationChallenge: {
              ...challenge,
              deliveryStatus: latest.status,
              sent: latest.status === 'sent',
              attempts: Math.min(5, challenge.attempts + 1),
              verifyOperationId: input.operationId,
            },
          };
          await repository.checkpoint(checkpoint, input.operationId);
          const value = await options.customerOtp.verify(
            user,
            checkoutCustomerOtpScope(checkpoint),
            challenge.id,
            input.operationId,
            otp,
          );
          if (!value.verifiedUntil || value.verifiedUntil <= now())
            throw new AppError(
              403,
              'CUSTOMER_OTP_EXPIRED',
              'Request a new customer verification code.',
            );
          return {
            state: {
              ...withCustomerOtpView(checkpoint, value),
              verifiedCustomerUntil: value.verifiedUntil,
              verifiedCustomerContact: value.contact,
            },
            result: { verified: true, expiresAt: value.verifiedUntil },
          };
        }
        if (!challenge?.sent || challenge.expiresAt <= now())
          throw new AppError(
            403,
            'CUSTOMER_OTP_CHALLENGE_REQUIRED',
            'Request a new customer verification code.',
          );
        if (
          !sameCustomerContact(
            challenge.contact,
            await repository.customerContact(state.customerId),
          )
        )
          throw new AppError(
            409,
            'CUSTOMER_CONTACT_CHANGED',
            'Customer contact changed. Request a new verification code.',
          );
        if (challenge.attempts >= 5)
          throw new AppError(
            429,
            'CUSTOMER_OTP_ATTEMPT_LIMIT',
            'Too many verification attempts. Request a new customer verification code.',
          );
        const checkpoint = {
          ...state,
          verificationChallenge: { ...challenge, attempts: challenge.attempts + 1 },
        };
        await repository.checkpoint(checkpoint, input.operationId);
        const result = z
          .object({ message: z.string() })
          .passthrough()
          .parse(
            await gateway.api('omnichannel-verifyotp', {
              user_id: wireId(state.customerId),
              otp: Number(otp.replaceAll('_', '')),
            }),
          );
        if (result.message !== 'OTP verified successfully!')
          throw new AppError(422, 'OTP_INVALID', 'The customer verification code is incorrect.');
        if (
          !sameCustomerContact(
            challenge.contact,
            await repository.customerContact(state.customerId),
          )
        )
          throw new AppError(
            409,
            'CUSTOMER_CONTACT_CHANGED',
            'Customer contact changed. Request a new verification code.',
          );
        return {
          state: {
            ...checkpoint,
            verificationChallenge: { ...checkpoint.verificationChallenge, sent: false },
            verifiedCustomerUntil: now() + 15 * 60000,
            verifiedCustomerContact: challenge.contact,
          },
          result: { verified: true, expiresAt: now() + 15 * 60000 },
        };
      });
    },
    async reconcileVerification(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
    ): Promise<MutationReply> {
      const state = await get(user, storeId, id);
      await options.assertCheckIn(user.id, storeId, state.counterId);
      const original = await repository.operation(user.id, storeId, id, input.operationId);
      if (!original)
        throw new AppError(
          404,
          'CHECKOUT_OPERATION_NOT_FOUND',
          'The original verification action was not found.',
        );
      if (original.status === 'succeeded' || original.status === 'rejected') {
        return original.status === 'succeeded' && original.result
          ? { status: 'succeeded', state, result: original.result.result }
          : {
              status: 'rejected',
              state,
              operationId: input.operationId,
              errorCode: original.errorCode,
            };
      }
      if (
        !options.customerOtp ||
        !state.verificationChallenge ||
        !customerVerificationOperation(state, input.operationId)
      )
        throw new AppError(
          409,
          'CUSTOMER_VERIFICATION_RECOVERY_CONFLICT',
          'This action is no longer the current customer verification.',
        );
      let evidence: CustomerVerificationEvidence | null;
      try {
        evidence = await options.customerOtp.readOperation(
          user,
          checkoutCustomerOtpScope(state),
          state.verificationChallenge.id,
          input.operationId,
        );
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['CUSTOMER_OTP_SCOPE_CHANGED', 'CHECKOUT_CUSTOMER_UNAVAILABLE'].includes(error.code)
        )
          throw error;
        evidence = {
          kind: 'revoked',
          errorCode:
            error.code === 'CUSTOMER_OTP_SCOPE_CHANGED'
              ? 'CUSTOMER_OTP_SCOPE_CHANGED'
              : 'CHECKOUT_CUSTOMER_UNAVAILABLE',
        };
      }
      if (!evidence)
        return {
          status: original.status,
          state,
          operationId: input.operationId,
          errorCode: 'CUSTOMER_VERIFICATION_OUTCOME_UNPROVED',
        };
      const repaired = await repository.reconcileCustomerVerification(
        user.id,
        storeId,
        id,
        input,
        evidence,
      );
      return repaired.receipt.status === 'succeeded' && repaired.receipt.result
        ? { status: 'succeeded', state: repaired.state, result: repaired.receipt.result.result }
        : {
            status: repaired.receipt.status === 'succeeded' ? 'uncertain' : repaired.receipt.status,
            state: repaired.state,
            operationId: input.operationId,
            errorCode: repaired.receipt.errorCode,
          };
    },
    quote(user: Principal, storeId: string, id: string, input: MutationInput) {
      return mutate(user, storeId, id, input, 'quote.create', {}, async (state) => {
        editable(state);
        if (state.cart && giftCardRows(state.cart).length) assertGiftCardContract(environment);
        const auth = await token(state),
          c = context(state);
        await gateway.api('validatecheckout', validatePayload(c), auth);
        const cart = await readCart(state);
        const quote = z
          .record(z.string(), z.unknown())
          .parse(await gateway.api('processorder', processPayload(c, cart), auth));
        const quotedCart = cartSchema.parse(quote);
        if (giftCardRows(quotedCart).length) assertGiftCardContract(environment);
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
    async submit(user: Principal, storeId: string, id: string, input: MutationInput) {
      assertCheckoutProjectionReady(environment);
      assertRefundAllocationReady(environment);
      if (!options.verifyRefundAllocations)
        throw new AppError(
          503,
          'REFUND_ALLOCATION_VERIFIER_UNAVAILABLE',
          'Order refund validation must be configured before creating this sale.',
        );
      return mutate(user, storeId, id, input, 'order.create', {}, async (state) => {
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
        if (state.cart && giftCardRows(state.cart).length) assertGiftCardContract(environment);
        const auth = await token(state),
          c = context(state);
        // Revalidate immediately before submission; browser totals are never accepted.
        await gateway.api('validatecheckout', validatePayload(c), auth);
        const freshCart = await readCart(state),
          freshQuote = z
            .record(z.string(), z.unknown())
            .parse(await gateway.api('processorder', processPayload(c, freshCart), auth));
        const freshState: CheckoutState = {
          ...state,
          cart: cartSchema.parse(freshQuote),
          quote: freshQuote,
        };
        assertGiftCardValues(freshState, freshState.cart!);
        if (giftCardRows(freshState.cart!).length) assertGiftCardContract(environment);
        const consentAuthority = await requireCurrentSpendingAuthority(
          user,
          freshState,
          freshState.cart!,
        );
        assertCustomerConsentReady(environment);
        const before = discountTerms(state, environment.hs256 || environment.hs512 || ''),
          after = discountTerms(freshState, environment.hs256 || environment.hs512 || '');
        if (
          before.binding !== after.binding ||
          quotePayable(state.quote) !== quotePayable(freshQuote)
        )
          throw new AppError(
            409,
            'CHECKOUT_QUOTE_CHANGED',
            'Prices or benefits changed. Refresh the final quote and approval before creating the order.',
          );
        if (after.amount !== '0.00' && !options.discounts)
          throw new AppError(
            503,
            'DISCOUNT_APPROVAL_UNAVAILABLE',
            'Manager discount approval is not configured.',
          );
        const approval = options.discounts
          ? await options.discounts.authorize(user, freshState)
          : null;
        const acceptedQuote = state.quote;
        const dispatchOrder = async () => {
          try {
            return await gateway.api(
              'pos/order',
              orderPayload(
                c,
                state.counterId,
                state.operatorCustomerId,
                state.salespersonId,
                quotePayable(acceptedQuote),
                giftCardWireData(state.giftCards),
              ),
              auth,
            );
          } catch (error) {
            // The pinned PosOrder commits its header/store before later card
            // validation. Even 4xx can follow a partial order with no returned
            // ID. Never permit a second dispatch over that unknown creation.
            if (error instanceof CheckoutGatewayError && !error.uncertain)
              throw new CheckoutGatewayError(error.code, error.message, true, error.status);
            throw error;
          }
        };
        const created = z
          .object({
            order: z.union([z.string(), z.number()]),
            method: z.unknown(),
            isValid: z.unknown(),
            name: z.unknown(),
          })
          .passthrough()
          .parse(await dispatchOrder());
        const orderId = String(created.order),
          confirmation = confirmationPayload(
            created.order,
            created.method,
            created.isValid,
            created.name,
            c.storeId,
          );
        const orderCustomerConsent: CustomerConsent | null = consentAuthority
          ? {
              v: 1,
              contract: customerConsentContract,
              orderId,
              customerId: consentAuthority.customerId,
              operatorId: state.operatorId,
              storeId: state.storeId,
              counterId: state.counterId,
              contact: consentAuthority.contact,
              expiresAt: consentAuthority.expiresAt,
            }
          : null;
        const checkpoint: CheckoutState = {
          ...state,
          orderId,
          orderSubmissionOperationId: input.operationId,
          phase: 'order-created',
          paymentConfirmation: confirmation,
          confirmationPhase: 'not-dispatched',
          orderCustomerConsent,
        };
        // A process crash after this point retains the created order identity. It
        // never reissues pos/order or silently treats an unconfirmed call as paid.
        await repository.checkpoint(checkpoint, input.operationId);
        await options.verifyRefundAllocations!(checkpoint, orderId);
        if (approval) await options.discounts!.record(checkpoint, orderId, approval);
        if (orderCustomerConsent) await requireVerified(user, checkpoint);
        const dispatching: CheckoutState = { ...checkpoint, confirmationPhase: 'dispatching' };
        await repository.checkpoint(dispatching, input.operationId);
        await gateway.confirm(confirmation, auth, orderCustomerConsent);
        const acknowledged: CheckoutState = { ...dispatching, confirmationPhase: 'acknowledged' };
        await repository.checkpoint(acknowledged, input.operationId);
        return completeOrder(acknowledged, orderId);
      });
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
      assertCheckoutProjectionReady(environment);
      assertRefundAllocationReady(environment);
      const initial = await get(user, storeId, id);
      await options.assertCheckIn(user.id, storeId, initial.counterId);
      if (!options.verifyProjection || !options.finalizeOrder)
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
        await options.verifyProjection(reservation.state, reservation.state.orderId);
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
        await options.verifyProjection(reservation.state, orderId);
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
          ...publicMutation({
            ...receipt.result,
            result: {
              ...receipt.result.result,
              settlement,
              paymentStatus: settlement ? 'paid' : 'pending',
            },
          }),
        };
      }
      return receipt.result
        ? { status: receipt.status, ...publicMutation(receipt.result) }
        : { status: receipt.status, operationId: receipt.id, errorCode: receipt.errorCode };
    },
  };
}
export function giftCardWireData(cards: CheckoutState['giftCards']): Payload {
  const format = (date: string) => {
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
export function publicState(state: CheckoutState) {
  const {
    operatorCustomerId: _operatorCustomerId,
    paymentConfirmation: _paymentConfirmation,
    confirmationRecovery: _confirmationRecovery,
    registrationRecovery: _registrationRecovery,
    settlementNote: _settlementNote,
    verifiedCustomerContact: _verifiedCustomerContact,
    orderCustomerConsent: _orderCustomerConsent,
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
  };
}
export function publicMutation(value: MutationResult) {
  return { state: publicState(value.state), result: publicCart(value.result) };
}
