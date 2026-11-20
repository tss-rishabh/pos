import { z } from 'zod';
import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import {
  draftLineItemsSchema,
  orderNotificationsSchema,
  type DraftLineItem,
  type CheckoutState,
  type MutationInput,
} from './contracts.js';
import { issueCustomerToken, newTabId } from './crypto.js';
import type { CustomerLookupBody } from './customers/lookup.js';
import { publicCart, publicState } from './service-public.js';
import type { CheckoutServiceCore } from './service-core.js';

/** Checkout session: the order-copy cart port, create, read, order notifications and customer lookup. */
export function checkoutSessionMethods(core: CheckoutServiceCore) {
  const { repository, environment, options, now, get, readCart, editable, mutate, changeLine } =
    core;
  return {
    /** Internal port: only the copy coordinator may call it after writer reservation. */
    orderCopyCart: {
      read: (state: CheckoutState) => readCart(state),
      async setLine(
        state: CheckoutState,
        stepId: string,
        productId: string,
        quantity: number,
        expectedHash: string,
      ) {
        z.uuid().parse(stepId);
        if (!state.busyOperationId || state.orderCopy?.commandId !== state.busyOperationId)
          throw new AppError(
            409,
            'ORDER_COPY_NOT_RESERVED',
            'Reserve the original copy before changing its cart.',
          );
        // Gift helpers checkpoint the enclosing checkout operation; the copy
        // coordinator separately retains the immutable per-SKU step UUID.
        return (await changeLine(state, state.busyOperationId, productId, quantity, expectedHash))
          .state;
      },
    },
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
      // CreateOrderView.get (order/views.py:1518-1522): the walk-in token subject is the operator's
      // storefront account (`user_type = 8`); without one the page shows this message.
      const storefront = await repository.storefrontIdentity(user.id);
      if (!storefront)
        throw new AppError(
          409,
          'OPERATOR_CUSTOMER_MAPPING_MISSING',
          "User doesn't have any account as store-front user in thesouledstore. Please contact administrator.",
        );
      // `admin_user_id` is the first account with this pos_admin_id, any user_type (2861).
      const operator = (await repository.operatorIdentity(user.id)) ?? storefront;
      issueCustomerToken(storefront, environment, now());
      const timestamp = now();
      const state: CheckoutState = {
        id: crypto.randomUUID(),
        draftId,
        // Legacy always posts nps_feedback_switch=true from a checked, disabled box
        // (create_order.html:76, :5646) and always queues the order SMS (order/views.py:2831).
        orderNotifications: { sendSms: true, npsFeedback: true },
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
        storefrontCustomerId: storefront.id,
        storeId,
        counterId,
        tabId: newTabId(),
        customerId: null,
        verifiedCustomerUntil: null,
        verifiedCustomerContact: null,
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
      return publicState(await repository.create(state), options.cashbackCreditMessage);
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
          ...publicState(state, options.cashbackCreditMessage),
          registration,
          registrationRequestRecovery,
          settlement: options.prepaidSettlement ? await options.prepaidSettlement(state) : null,
        };
      if (
        state.phase === 'uncertain' ||
        state.phase === 'cleared' ||
        state.busyOperationId ||
        (state.orderCopy && state.orderCopy.status !== 'acknowledged') ||
        state.draftImport?.status === 'pending'
      )
        return {
          ...publicState(state, options.cashbackCreditMessage),
          registration,
          registrationRequestRecovery,
          settlement: null,
        };
      return {
        ...publicState(state, options.cashbackCreditMessage),
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
    async lookup(
      user: Principal,
      storeId: string,
      counterId: string,
      body: Pick<CustomerLookupBody, 'telephone' | 'email'>,
    ) {
      requireStore(user, storeId);
      await options.assertCheckIn(user.id, storeId, counterId);
      if (!options.customerLookup)
        throw new AppError(
          503,
          'CUSTOMER_LOOKUP_UNAVAILABLE',
          'Unable to fetch user details. Please try again.',
        );
      return options.customerLookup.lookup(body);
    },
  };
}
