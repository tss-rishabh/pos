import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { CheckoutState, MutationInput } from './contracts.js';
import { CheckoutGatewayError } from './gateway.js';
import { issueCustomerToken, operationHash } from './crypto.js';
import type { RegistrationDetails } from './customers/contracts.js';
import { switchedCustomerState } from './customers/switch.js';
import { clearCartPayload, syncCartPayload } from './payloads.js';
import { publicCart } from './service-public.js';
import type { CheckoutServiceCore, MutationReply } from './service-core.js';

/** Customer attach and the legacy registration flow (request, verify, resend, register, reconcile). */
export function checkoutCustomerMethods(core: CheckoutServiceCore) {
  const {
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
    editable,
    mutate,
  } = core;
  return {
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
        if (state.customerId && state.customerId !== customerId) {
          // Legacy "Connect the User" with a customer already connected (is_cart_sync = 0,
          // order/views.py:1994-2019): re-point the sale, no cart sync or clear.
          const previous = state.customerId;
          await repository.acquireCustomer(id, customerId);
          const switched = switchedCustomerState(state, customerId, null, null, now());
          await repository.checkpoint(switched, input.operationId);
          await repository.releaseCustomer(id, previous);
          const cart = await readCart(switched);
          return {
            state: { ...switched, cart },
            result: {
              customer: {
                id: customer.id,
                firstName: customer.firstName,
                lastName: customer.lastName,
              },
              cart: publicCart(cart),
            },
          };
        }
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
    /** S36: legacy "Self Verify (Without OTP)" (`order/views.py:2429-2448`) with the OTP-sent guard. */
    selfVerifyRegistration(
      user: Principal,
      storeId: string,
      id: string,
      input: MutationInput,
      telephone: string,
    ) {
      return mutate(
        user,
        storeId,
        id,
        input,
        'customer.registration.self-verify',
        { telephone },
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
            result: { registration: await options.registrations.selfVerify(state, telephone) },
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
  };
}
