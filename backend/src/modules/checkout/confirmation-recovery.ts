import { AppError } from '../../domain/errors.js';
import type { CheckoutState, OperationReceipt } from './contracts.js';

export const confirmationRecoveryLeaseMs = 60_000;
export interface ConfirmationRecoveryLease {
  leaseId: string;
  now: number;
  purpose?: 'confirmation' | 'registration-request';
}

/** Recovery can inspect a known dispatched order; it never grants a new dispatch. */
export function reserveConfirmationRecovery(
  state: CheckoutState,
  operationId: string,
  lease: ConfirmationRecoveryLease,
): CheckoutState {
  if (
    !state.orderId ||
    !state.orderSubmissionOperationId ||
    operationId === state.orderSubmissionOperationId ||
    !['order-created', 'uncertain'].includes(state.phase) ||
    !['dispatching', 'acknowledged'].includes(state.confirmationPhase ?? '')
  )
    throw new AppError(
      409,
      'CHECKOUT_CONFIRMATION_NOT_RECOVERABLE',
      'Only a saved order with a dispatched confirmation can be reconciled here.',
    );
  if (state.busyOperationId) {
    const recovery = state.confirmationRecovery;
    const recovering = recovery && recovery.expiresAt <= lease.now;
    const interruptedSubmission =
      state.busyOperationId === state.orderSubmissionOperationId &&
      state.updatedAt + confirmationRecoveryLeaseMs <= lease.now;
    if (!recovering && !interruptedSubmission)
      throw new AppError(
        409,
        'CHECKOUT_CONFIRMATION_IN_PROGRESS',
        'Confirmation is still processing. Check its status before reconciling it.',
      );
  }
  return {
    ...state,
    phase: 'uncertain',
    busyOperationId: operationId,
    confirmationRecovery: {
      leaseId: lease.leaseId,
      expiresAt: lease.now + confirmationRecoveryLeaseMs,
    },
    updatedAt: lease.now,
  };
}

export function recoveryReplay(
  state: CheckoutState,
  receipt: Pick<OperationReceipt, 'id' | 'status'>,
  lease: ConfirmationRecoveryLease,
): boolean {
  return (
    receipt.status !== 'inflight' ||
    state.busyOperationId !== receipt.id ||
    !(state.confirmationRecovery ?? state.registrationRecovery) ||
    (state.confirmationRecovery ?? state.registrationRecovery)!.expiresAt > lease.now
  );
}

/** The nonce fences an old worker after another request reclaims an expired lease. */
export function currentCheckoutOperation(
  current: CheckoutState,
  expected: CheckoutState,
  operationId: string,
  now = Date.now(),
): boolean {
  const actual = current.confirmationRecovery ?? current.registrationRecovery,
    previous = expected.confirmationRecovery ?? expected.registrationRecovery;
  return (
    current.busyOperationId === operationId &&
    (actual?.leaseId ?? null) === (previous?.leaseId ?? null) &&
    (!actual || actual.expiresAt > now)
  );
}
