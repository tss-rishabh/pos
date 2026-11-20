import { z } from 'zod';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { CheckoutState, MutationInput } from './contracts.js';
import { outboundAllowlistEnabled, outboundPermitted } from '../../outbound/allowlist.js';
import { sameCustomerContact } from './customer-contact-authority.js';
import {
  checkoutCustomerOtpScope,
  customerVerificationOperation,
  withCustomerOtpView,
  type CustomerVerificationEvidence,
} from './customer-verification.js';
import { wireId } from './payloads.js';
import type { CheckoutServiceCore, MutationReply } from './service-core.js';

/** Customer OTP verification: send, verify and reconcile. */
export function checkoutVerificationMethods(core: CheckoutServiceCore) {
  const { repository, gateway, options, now, get, editable, mutate } = core;
  return {
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
        // Allowlist guard (w25): API-v2 sends to the customer's phone and email; a suppressed
        // send answers like an accepted one.
        let suppressed = false;
        if (outboundAllowlistEnabled()) {
          gateway.assertApiReady?.();
          suppressed = !(await outboundPermitted({
            channel: 'api-v2',
            module: 'checkout',
            flow: 'customer-otp',
            targets: [{ kind: 'customer', id: state.customerId }],
          }));
        }
        const result = z
          .object({ mobile: z.boolean().optional(), email: z.boolean().optional() })
          .passthrough()
          .parse(
            suppressed
              ? { mobile: true, email: true }
              : await gateway.api('omnichannel-sendotp', { user_id: wireId(state.customerId) }),
          );
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
  };
}
