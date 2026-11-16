import { AppError } from '../../domain/errors.js';
import type {
  CustomerOtpScope,
  CustomerOtpView,
  CustomerOtpOperationView,
  customerOtpService,
} from '../customer-otp/index.js';
import type { CheckoutState, MutationInput, OperationReceipt } from './contracts.js';
import { sameCustomerContact, type CustomerContactBinding } from './customer-contact-authority.js';

export type CustomerVerificationClient = Pick<
  ReturnType<typeof customerOtpService>,
  'request' | 'verify' | 'read' | 'readOperation'
> &
  Partial<Pick<ReturnType<typeof customerOtpService>, 'assertVerified'>>;
export type CustomerVerificationEvidence =
  | CustomerOtpOperationView
  | {
      kind: 'revoked';
      errorCode: 'CUSTOMER_OTP_SCOPE_CHANGED' | 'CHECKOUT_CUSTOMER_UNAVAILABLE';
    };

export function checkoutCustomerOtpScope(state: CheckoutState): CustomerOtpScope {
  if (!state.customerId) throw new AppError(409, 'CUSTOMER_REQUIRED', 'Connect a customer first.');
  return {
    operatorId: state.operatorId,
    storeId: state.storeId,
    counterId: state.counterId,
    customerId: state.customerId,
    subjectId: state.id,
    purpose: 'checkout-benefits',
    orderId: null,
  };
}

export function customerVerificationOperation(
  state: CheckoutState,
  operationId: string,
): 'request' | 'verify' | null {
  if (state.verificationChallenge?.requestOperationId === operationId) return 'request';
  if (state.verificationChallenge?.verifyOperationId === operationId) return 'verify';
  return null;
}

export function withCustomerOtpView(state: CheckoutState, value: CustomerOtpView): CheckoutState {
  const challenge = state.verificationChallenge;
  if (
    !challenge ||
    challenge.id !== value.id ||
    !sameCustomerContact(challenge.contact, value.contact)
  )
    throw new AppError(
      409,
      'CUSTOMER_OTP_SCOPE_CHANGED',
      'The customer or sale changed. Request a new verification code.',
    );
  return {
    ...state,
    verificationChallenge: {
      ...challenge,
      sent: value.status === 'sent',
      deliveryStatus: value.status,
      expiresAt: value.expiresAt,
    },
  };
}

/** Repairs only an already committed OTP action. It cannot send a code or consume an attempt. */
export function reconcileCustomerVerificationState(
  state: CheckoutState,
  receipt: OperationReceipt,
  input: MutationInput,
  evidence: CustomerVerificationEvidence,
  currentContact: CustomerContactBinding | null,
  now: number,
): { state: CheckoutState; receipt: OperationReceipt } {
  if (receipt.checkoutId !== state.id || receipt.id !== input.operationId)
    throw new AppError(
      404,
      'CHECKOUT_OPERATION_NOT_FOUND',
      'The original verification action was not found.',
    );
  if (receipt.status === 'succeeded' || receipt.status === 'rejected') return { state, receipt };
  const kind = customerVerificationOperation(state, input.operationId);
  if (
    !kind ||
    (evidence.kind !== 'revoked' && (kind !== evidence.kind || !evidence.result)) ||
    state.orderId ||
    !['open', 'quoted'].includes(state.phase) ||
    (state.busyOperationId && state.busyOperationId !== input.operationId)
  )
    throw new AppError(
      409,
      'CUSTOMER_VERIFICATION_RECOVERY_CONFLICT',
      'This action is no longer the current customer verification.',
    );
  if (state.version !== input.expectedVersion)
    throw new AppError(
      409,
      'CHECKOUT_VERSION_CONFLICT',
      'This checkout changed. Reload it before continuing.',
    );
  if (evidence.kind === 'revoked') {
    const next: CheckoutState = {
      ...state,
      version: state.version + 1,
      busyOperationId: null,
      updatedAt: now,
      verifiedCustomerUntil: null,
      verifiedCustomerContact: null,
      verificationChallenge: state.verificationChallenge
        ? { ...state.verificationChallenge, sent: false, deliveryStatus: 'rejected' }
        : null,
    };
    return {
      state: next,
      receipt: { ...receipt, status: 'rejected', errorCode: evidence.errorCode, result: null },
    };
  }
  if (!evidence.result)
    throw new AppError(
      409,
      'CUSTOMER_VERIFICATION_RECOVERY_CONFLICT',
      'The original verification outcome could not be proved.',
    );
  if (
    !sameCustomerContact(state.verificationChallenge?.contact, currentContact) ||
    !sameCustomerContact(evidence.result.contact, currentContact)
  )
    throw new AppError(
      409,
      'CUSTOMER_CONTACT_CHANGED',
      'Customer contact changed. Request a new verification code.',
    );
  let next = withCustomerOtpView(state, evidence.result);
  // A wrong-code receipt stays rejected even if a later action verified the same challenge.
  const verified =
    kind === 'verify' &&
    !evidence.error &&
    !!evidence.result.verifiedUntil &&
    evidence.result.verifiedUntil > now;
  const error = evidence.error || (kind === 'verify' && !verified ? 'CUSTOMER_OTP_EXPIRED' : null);
  next = {
    ...next,
    version: state.version + 1,
    busyOperationId: null,
    updatedAt: now,
    ...(verified
      ? {
          verifiedCustomerUntil: evidence.result.verifiedUntil,
          verifiedCustomerContact: currentContact,
        }
      : {}),
  };
  const result =
    kind === 'request'
      ? {
          queued: true,
          deliveryStatus: evidence.result.status,
          expiresAt: evidence.result.expiresAt,
        }
      : { verified, expiresAt: verified ? evidence.result.verifiedUntil : null };
  return {
    state: next,
    receipt: {
      ...receipt,
      status: error ? 'rejected' : 'succeeded',
      errorCode: error,
      result: error ? null : { state: next, result },
    },
  };
}
