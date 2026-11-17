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
  type ProviderDecision,
} from './contracts.js';
import type { PaymentRepository } from './repository.js';
import { capturePaymentDispatch, type PaymentDispatchFrame } from './dispatch-evidence.js';

export function paymentService(repository: PaymentRepository, gateway: PaymentGateway) {
  async function unconfirmed(
    user: Principal,
    attempt: PaymentAttempt,
    machine: Terminal | null,
    error: unknown,
    dispatch?: PaymentDispatchFrame,
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
      dispatch,
    );
    throw new AppError(
      502,
      code,
      'The payment outcome is unconfirmed. Reconcile this attempt before taking another payment.',
    );
  }
  async function receive(
    user: Principal,
    attempt: PaymentAttempt,
    machine: Terminal | null,
    dispatch: PaymentDispatchFrame,
    perform: () => Promise<ProviderDecision>,
  ) {
    let decision: ProviderDecision;
    try {
      decision = await perform();
    } catch (error) {
      return unconfirmed(user, attempt, machine, error, dispatch);
    }
    // A native validation/authority failure after the provider reply is not a
    // second provider observation. Retain that real reply and preserve the
    // original error without replacing it with synthetic uncertainty.
    return publicPayment(
      await repository.decision(
        user,
        attempt.storeId,
        attempt.orderId,
        attempt.id,
        decision,
        machine,
        attempt.busyOperationId,
        dispatch,
      ),
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
      const dispatch = capturePaymentDispatch(attempt, machine, 'start', user.id);
      return receive(user, attempt, machine, dispatch, () =>
        machine
          ? gateway.start(attempt, machine)
          : Promise.resolve({
              status: 'paid',
              reference: attempt.transactionId,
              code: 'OPERATOR_RECORDED',
            }),
      );
    },
    async get(user: Principal, storeId: string, orderId: string, id: string) {
      return publicPayment(await repository.get(user, storeId, orderId, id));
    },
    async reconcile(user: Principal, storeId: string, orderId: string, id: string) {
      const recovered = await repository.context(user, storeId, orderId, id);
      const { attempt, machine } = recovered;
      if (['paid', 'failed', 'cancelled', 'reversed'].includes(attempt.status))
        return publicPayment(attempt);
      if (recovered.retainedDecision && recovered.retainedFactId)
        return publicPayment(
          await repository.decision(
            user,
            storeId,
            orderId,
            id,
            recovered.retainedDecision,
            null,
            attempt.busyOperationId,
            undefined,
            recovered.retainedFactId,
          ),
        );
      const dispatch = capturePaymentDispatch(attempt, machine, 'status', user.id);
      // Reconciliation may repeat a provider status enquiry. It never repeats the
      // original charge dispatch, including after a worker/process crash.
      return receive(user, attempt, machine, dispatch, () =>
        machine
          ? gateway.status(attempt, machine)
          : Promise.resolve({
              status: 'paid',
              reference: attempt.transactionId,
              code: 'OPERATOR_RECORDED',
            }),
      );
    },
    async cancel(user: Principal, storeId: string, orderId: string, id: string) {
      const { attempt, machine } = await repository.context(user, storeId, orderId, id, true);
      if (['failed', 'cancelled', 'reversed'].includes(attempt.status))
        return publicPayment(attempt);
      if (attempt.status === 'paid' || !terminalPayment(attempt.channel) || !machine)
        throw new AppError(
          409,
          'PAYMENT_NOT_CANCELLABLE',
          'A paid settlement requires the refund flow.',
        );
      const dispatch = capturePaymentDispatch(attempt, machine, 'cancel', user.id);
      return receive(user, attempt, machine, dispatch, () => gateway.cancel(attempt, machine));
    },
  };
}
