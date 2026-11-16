import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import {
  publicPayment,
  terminalPayment,
  type PaymentInput,
  type PaymentGateway,
  type PaymentAttempt,
  type Terminal,
  type LegacyPaymentRecoveryInput,
} from './contracts.js';
import type { PaymentRepository } from './repository.js';

export function paymentService(repository: PaymentRepository, gateway: PaymentGateway) {
  async function unconfirmed(
    user: Principal,
    attempt: PaymentAttempt,
    machine: Terminal | null,
    error: unknown,
  ): Promise<never> {
    const code = error instanceof AppError ? error.code : 'PAYMENT_OUTCOME_UNCERTAIN';
    await repository.decision(
      user,
      attempt.storeId,
      attempt.orderId,
      attempt.id,
      { status: 'uncertain', reference: attempt.providerReference, code },
      machine,
      attempt.busyOperationId,
    );
    throw new AppError(
      502,
      code,
      'The payment outcome is unconfirmed. Reconcile this attempt before taking another payment.',
    );
  }
  return {
    paymentContext(user: Principal, storeId: string, orderId: string) {
      return repository.paymentContext(user, storeId, orderId);
    },
    async adoptLegacy(
      user: Principal,
      storeId: string,
      orderId: string,
      input: LegacyPaymentRecoveryInput,
    ) {
      // Local adoption records the already-dispatched source transaction only.
      // A separate explicit reconciliation is a provider status enquiry, never a charge.
      return publicPayment(await repository.adoptLegacy(user, storeId, orderId, input));
    },
    options(user: Principal, storeId: string, orderId: string) {
      return repository.options(user, storeId, orderId);
    },
    async list(user: Principal, storeId: string, orderId: string) {
      return (await repository.list(user, storeId, orderId)).map(publicPayment);
    },
    async start(user: Principal, storeId: string, orderId: string, input: PaymentInput) {
      gateway.configured(input.channel);
      const { attempt, machine, replay } = await repository.begin(user, storeId, orderId, input);
      if (replay) return publicPayment(attempt);
      try {
        const decision = machine
          ? await gateway.start(attempt, machine)
          : {
              status: 'paid' as const,
              reference: attempt.transactionId,
              code: 'OPERATOR_RECORDED',
            };
        return publicPayment(
          await repository.decision(
            user,
            storeId,
            orderId,
            attempt.id,
            decision,
            machine,
            attempt.busyOperationId,
          ),
        );
      } catch (error) {
        return unconfirmed(user, attempt, machine, error);
      }
    },
    async get(user: Principal, storeId: string, orderId: string, id: string) {
      return publicPayment(await repository.get(user, storeId, orderId, id));
    },
    async reconcile(user: Principal, storeId: string, orderId: string, id: string) {
      const { attempt, machine } = await repository.context(user, storeId, orderId, id);
      if (['paid', 'failed', 'cancelled'].includes(attempt.status)) return publicPayment(attempt);
      // Reconciliation may repeat a provider status enquiry. It never repeats the
      // original charge dispatch, including after a worker/process crash.
      try {
        const decision = machine
          ? await gateway.status(attempt, machine)
          : {
              status: 'paid' as const,
              reference: attempt.transactionId,
              code: 'OPERATOR_RECORDED',
            };
        return publicPayment(
          await repository.decision(
            user,
            storeId,
            orderId,
            id,
            decision,
            machine,
            attempt.busyOperationId,
          ),
        );
      } catch (error) {
        return unconfirmed(user, attempt, machine, error);
      }
    },
    async cancel(user: Principal, storeId: string, orderId: string, id: string) {
      const { attempt, machine } = await repository.context(user, storeId, orderId, id, true);
      if (['failed', 'cancelled'].includes(attempt.status)) return publicPayment(attempt);
      if (attempt.status === 'paid' || !terminalPayment(attempt.channel) || !machine)
        throw new AppError(
          409,
          'PAYMENT_NOT_CANCELLABLE',
          'A paid settlement requires the refund flow.',
        );
      try {
        return publicPayment(
          await repository.decision(
            user,
            storeId,
            orderId,
            id,
            await gateway.cancel(attempt, machine),
            machine,
            attempt.busyOperationId,
          ),
        );
      } catch (error) {
        return unconfirmed(user, attempt, machine, error);
      }
    },
  };
}
