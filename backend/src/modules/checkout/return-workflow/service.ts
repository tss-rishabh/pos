import { Temporal } from '@js-temporal/polyfill';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { CheckoutRepository } from '../contracts.js';
import { issueCustomerToken } from '../crypto.js';
import { CheckoutGatewayError } from '../gateway.js';
import type { CheckoutEnvironment } from '../gateway.js';
import {
  publicReturn,
  type ReturnGateway,
  type ReturnInput,
  type ReturnOperation,
} from './contracts.js';
import type { ReturnRepository } from './repository.js';

export async function acceptInbound(
  user: Principal,
  operation: ReturnOperation,
  repository: ReturnRepository,
  customers: CheckoutRepository,
  gateway: ReturnGateway,
  signing: CheckoutEnvironment,
  timeZone: string,
) {
  let dispatched = false;
  try {
    const customer = await customers.customer(operation.customerId);
    if (!customer)
      throw new AppError(
        409,
        'RETURN_CUSTOMER_UNAVAILABLE',
        'The order customer could not be confirmed.',
      );
    const eligibility = await gateway.eligibility(
      operation.orderId,
      operation.storeId,
      operation.lineId,
      issueCustomerToken(customer, signing),
      operation.kind,
    );
    const today = Temporal.Now.zonedDateTimeISO(timeZone).toPlainDate(),
      override =
        operation.kind === 'return' &&
        user.role === 1 &&
        operation.input.overrideEligibility &&
        eligibility.until !== null &&
        Temporal.PlainDate.compare(
          Temporal.PlainDate.from(eligibility.until.slice(0, 10)),
          today,
        ) >= 0;
    if (!eligibility.allowed && !override)
      throw new AppError(
        409,
        'RETURN_NOT_ELIGIBLE',
        'The order service did not approve this line for this operation.',
      );
    const data = await repository.inboundData(user, operation.storeId, operation.id);
    dispatched = true;
    await gateway.inbound(data);
    return await repository.accepted(user, operation.storeId, operation.id);
  } catch (error) {
    const uncertain =
        dispatched &&
        (!(error instanceof AppError) ||
          (error instanceof CheckoutGatewayError && error.uncertain)),
      code =
        error instanceof AppError
          ? error.code
          : uncertain
            ? 'RETURN_OUTCOME_UNCERTAIN'
            : 'RETURN_PROCESSING_FAILED';
    await repository.failure(user, operation.storeId, operation.id, 'inbound', uncertain, code);
    if (error instanceof AppError && !uncertain) throw error;
    throw new AppError(
      502,
      code,
      'The warehouse result needs review. The return leg will not be repeated automatically.',
    );
  }
}

export function returnService(
  repository: ReturnRepository,
  customers: CheckoutRepository,
  gateway: ReturnGateway,
  signing: CheckoutEnvironment,
  timeZone: string,
) {
  async function handleFailure(
    user: Principal,
    operation: ReturnOperation,
    error: unknown,
    externalDispatched: boolean,
  ): Promise<never> {
    const stage = operation.phase.startsWith('refund') ? 'refund' : 'inbound',
      uncertain =
        externalDispatched &&
        (stage === 'refund' ||
          !(error instanceof AppError) ||
          (error instanceof CheckoutGatewayError && error.uncertain)),
      code =
        error instanceof AppError
          ? error.code
          : uncertain
            ? 'RETURN_OUTCOME_UNCERTAIN'
            : 'RETURN_PROCESSING_FAILED';
    await repository.failure(user, operation.storeId, operation.id, stage, uncertain, code);
    if (error instanceof AppError && !uncertain) throw error;
    throw new AppError(
      502,
      code,
      'This return needs review. Its warehouse or refund action will not be repeated automatically.',
    );
  }
  async function refund(user: Principal, operation: ReturnOperation) {
    let current = operation,
      dispatched = false;
    try {
      current = await repository.claimRefund(user, current.storeId, current.id);
      dispatched = true;
      const response = await gateway.refund({
        customerId: current.customerId,
        orderId: current.orderId,
        productId: current.productId,
        lineId: current.lineId,
        wallet: current.input.refundMode === 'tss-money',
        superAdmin: user.role === 1,
      });
      current = await repository.refundConfirmed(
        user,
        current.storeId,
        current.id,
        response.returnAmount,
      );
      return publicReturn(await repository.complete(user, current.storeId, current.id));
    } catch (error) {
      return handleFailure(user, current, error, dispatched);
    }
  }
  return {
    async start(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ReturnInput,
    ) {
      gateway.configured();
      const { operation, replay } = await repository.begin(user, storeId, orderId, lineId, input);
      if (replay) return publicReturn(operation);
      const current = await acceptInbound(
        user,
        operation,
        repository,
        customers,
        gateway,
        signing,
        timeZone,
      );
      return refund(user, current);
    },
    async read(user: Principal, storeId: string, id: string) {
      return publicReturn(await repository.read(user, storeId, id));
    },
    async continue(user: Principal, storeId: string, id: string) {
      const operation = await repository.read(user, storeId, id);
      if (operation.kind !== 'return')
        throw new AppError(409, 'RETURN_KIND_MISMATCH', 'This operation is not a refund return.');
      if (operation.phase === 'completed') return publicReturn(operation);
      if (operation.phase === 'refund-confirmed')
        return publicReturn(await repository.complete(user, storeId, id));
      if (operation.phase === 'inbound-accepted') {
        gateway.configured();
        return refund(user, operation);
      }
      throw new AppError(
        409,
        'RETURN_REVIEW_REQUIRED',
        'The external return action needs reconciliation before this operation can continue.',
      );
    },
  };
}
