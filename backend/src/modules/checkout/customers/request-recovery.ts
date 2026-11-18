import { AppError } from '../../../domain/errors.js';
import type { CheckoutState, OperationReceipt } from '../contracts.js';
import {
  confirmationRecoveryLeaseMs,
  type ConfirmationRecoveryLease,
} from '../confirmation-recovery.js';

/** The Redis registration record proves the request; this lease never sends a message. */
export function reserveRegistrationRequestRecovery(
  state: CheckoutState,
  operationId: string,
  lease: ConfirmationRecoveryLease,
  origin: OperationReceipt | null,
): CheckoutState {
  if (
    state.orderId ||
    !state.registrationId ||
    operationId === state.registrationId ||
    !origin ||
    origin.id !== state.registrationId ||
    origin.status === 'succeeded' ||
    origin.result
  )
    throw new AppError(
      409,
      'CUSTOMER_REGISTRATION_REQUEST_NOT_RECOVERABLE',
      'Only an interrupted queued registration request can be recovered here.',
    );
  if (state.busyOperationId) {
    const expired = state.registrationRecovery && state.registrationRecovery.expiresAt <= lease.now,
      original =
        state.busyOperationId === state.registrationId &&
        state.updatedAt + confirmationRecoveryLeaseMs <= lease.now;
    if (!expired && !original)
      throw new AppError(
        409,
        'CUSTOMER_REGISTRATION_REQUEST_IN_PROGRESS',
        'Registration is still processing. Check its status before recovery.',
      );
  }
  return {
    ...state,
    busyOperationId: operationId,
    phase: 'uncertain',
    registrationRecovery: {
      leaseId: lease.leaseId,
      expiresAt: lease.now + confirmationRecoveryLeaseMs,
    },
    updatedAt: lease.now,
  };
}
