import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../../config.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { JobProducer } from '../../../jobs/contract.js';
import type { CheckoutRepository } from '../contracts.js';
import { issueCustomerToken } from '../crypto.js';
import { CheckoutGatewayError } from '../gateway.js';
import type { CheckoutEnvironment } from '../gateway.js';
import { pythonFloat, pythonRepr } from '../payments/legacy.js';
import { currentRequestTrace } from '../../../observability/context.js';
import {
  publicReturn,
  type ExchangeRecoveryScope,
  type LineEligibility,
  type LineEligibilityView,
  type ReturnGateway,
  type ReturnInput,
  type ReturnOperation,
} from './contracts.js';
import {
  exchangeCell,
  exchangeRefusal,
  returnExchangeMerged,
  type ExchangeCellFacts,
} from './exchange-cell.js';
import type { ReturnRepository } from './repository.js';
import type { ReturnGatewayLog } from './gateway.js';
import type { RegisteredEvent } from '../../../observability/event-registry.js';

export interface ReturnServiceContext {
  repository: ReturnRepository;
  customers: Pick<CheckoutRepository, 'customer' | 'operatorIdentity'>;
  gateway: ReturnGateway;
  signing: CheckoutEnvironment;
  config: Pick<Config, 'BUSINESS_TIMEZONE' | 'EXCHANGE_ENABLED_STORE_IDS'>;
  jobs?: JobProducer;
  log?: ReturnGatewayLog;
}

/** `Helpers.is_date_in_window` (helpers/helpers.py:1774-1778); an unparsable date is not in window. */
function dateInWindow(value: string | null, timeZone: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    return (
      Temporal.PlainDate.compare(
        Temporal.Now.zonedDateTimeISO(timeZone).toPlainDate(),
        Temporal.PlainDate.from(value),
      ) <= 0
    );
  } catch {
    return false;
  }
}

/** `Helpers.can_super_admin_override_return` (helpers/helpers.py:1780-1789). */
export function superAdminReturnOverride(
  role: number,
  entry: LineEligibility['return'] | null,
  lineStatus: string | null,
  returnStatus: number,
  timeZone: string,
) {
  return Boolean(
    role === 1 &&
    entry &&
    !entry.status &&
    lineStatus === 'DELIVERED' &&
    returnStatus === 0 &&
    dateInWindow(entry.upto, timeZone),
  );
}

export async function customerToken(context: ReturnServiceContext, customerId: string) {
  const customer = await context.customers.customer(customerId);
  if (!customer)
    throw new AppError(
      409,
      'RETURN_CUSTOMER_UNAVAILABLE',
      'The order customer could not be confirmed.',
    );
  return issueCustomerToken(customer, context.signing);
}

/**
 * `return_processed` failure path (order/libs/calculations.py:160-170): when the warehouse return
 * is not confirmed, an order with an `order_stores` row is pushed to Vinculum again through the
 * `push_vinc_order_for_all` Celery task, and the operator is asked to retry later.
 */
async function warehouseFailure(
  context: ReturnServiceContext,
  user: Principal,
  operation: ReturnOperation,
  code: string,
): Promise<never> {
  const storeOrder = await context.repository.hasOrderStore(operation.orderId);
  const message = storeOrder
    ? 'Order is under process, Please try again in 5 minutes.'
    : 'Something went wrong, Please try again in sometime.';
  await context.repository.failure(
    user,
    operation.storeId,
    operation.id,
    'inbound',
    false,
    code,
    message,
  );
  if (storeOrder) {
    if (context.jobs)
      await context.jobs.enqueue(
        'core.tasks.push_vinc_order_for_all',
        { order_id: Number(operation.orderId) },
        { queue: 'core' },
      );
    else {
      const trace = currentRequestTrace();
      context.log?.warn(
        {
          module: 'checkout',
          resource: 'return-operation',
          eventId: 'checkout.return-operation.vinculum-push-unqueued',
          requestId: trace?.requestId ?? null,
          userId: trace?.userId ?? null,
        } satisfies RegisteredEvent,
        'No job producer is configured for push_vinc_order_for_all',
      );
    }
  }
  throw new AppError(502, storeOrder ? 'RETURN_WAREHOUSE_PENDING' : code, message);
}

/**
 * Server check of the template gate that offered the action, then the warehouse return
 * (`return_processed` → `Helpers.create_return_at_vinculum`) and its native writes.
 */
export async function acceptInbound(
  user: Principal,
  operation: ReturnOperation,
  context: ReturnServiceContext,
) {
  const { repository, gateway } = context;
  let eligibility;
  try {
    eligibility = await gateway.orderEligibility(
      operation.orderId,
      operation.storeId,
      await customerToken(context, operation.customerId),
    );
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'RETURN_ELIGIBILITY_UNAVAILABLE';
    await repository.failure(user, operation.storeId, operation.id, 'inbound', false, code, null);
    throw error instanceof AppError
      ? error
      : new AppError(502, code, 'Return eligibility could not be confirmed.');
  }
  const line = eligibility.get(operation.lineId) ?? null,
    entry = operation.kind === 'exchange' ? line?.exchange : line?.return;
  let permitted = Boolean(entry?.status);
  // S35: an online product-type-8 line offers an exchange only in the merged cell.
  const typeEight =
    operation.kind === 'exchange' && operation.guard && line
      ? exchangeRefusal({
          ...operation.guard,
          exchangeFeatureEnabled: true,
          retry: false,
          merged: returnExchangeMerged(line.return, line.exchange),
        })
      : null;
  if (typeEight) permitted = false;
  if (!permitted && operation.kind === 'return' && line) {
    // Super-admin override button (show.html:236-238 / online cells :48-50).
    if (operation.input.overrideEligibility)
      permitted =
        user.role === 1 &&
        !line.return.status &&
        dateInWindow(line.return.upto, context.config.BUSINESS_TIMEZONE);
    // Force return (show.html:258-266): only when the service gave neither status nor reason.
    else if (operation.input.clickType === 'extreme')
      permitted = !line.return.status && !line.return.reason;
  }
  if (!permitted) {
    await repository.failure(
      user,
      operation.storeId,
      operation.id,
      'inbound',
      false,
      typeEight?.code ?? 'RETURN_NOT_ELIGIBLE',
      null,
    );
    throw typeEight
      ? new AppError(typeEight.status, typeEight.code, typeEight.message)
      : new AppError(
          409,
          'RETURN_NOT_ELIGIBLE',
          operation.kind === 'exchange'
            ? 'Not applicable for exchange'
            : 'This order is not applicable for return',
        );
  }
  try {
    await gateway.inbound(await repository.inboundData(user, operation.storeId, operation.id));
  } catch (error) {
    if (error instanceof AppError && !(error instanceof CheckoutGatewayError)) {
      await repository.failure(
        user,
        operation.storeId,
        operation.id,
        'inbound',
        false,
        error.code,
        null,
      );
      throw error;
    }
    // Legacy treats every Vinculum exception or non-success the same way (calculations.py:153-170).
    return warehouseFailure(
      context,
      user,
      operation,
      error instanceof AppError ? error.code : 'RETURN_INBOUND_REJECTED',
    );
  }
  return repository.accepted(user, operation.storeId, operation.id);
}

export function returnService(context: ReturnServiceContext) {
  const { repository, gateway } = context,
    state = repository.state;
  async function refund(user: Principal, operation: ReturnOperation) {
    let current = await repository.claimRefund(user, operation.storeId, operation.id);
    try {
      const response = await gateway.refund({
        customerId: current.customerId,
        orderId: current.orderId,
        productId: current.productId,
        lineId: current.lineId,
        wallet: current.input.refundMode !== 'cash',
        superAdmin: user.role === 1,
      });
      if (response.kind === 'already-refunded') {
        await repository.alreadyRefunded(user, current.storeId, current.id);
        throw new AppError(409, 'RETURN_ALREADY_REFUNDED', 'Already refunded');
      }
      current = await repository.refundConfirmed(
        user,
        current.storeId,
        current.id,
        response.returnAmount,
        // API-v2 serialises the amount as a float; Django stores repr(return_amt).
        typeof response.returnAmountRaw === 'number'
          ? pythonFloat(response.returnAmountRaw)
          : pythonRepr(response.returnAmountRaw),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'RETURN_ALREADY_REFUNDED') throw error;
      const code = error instanceof AppError ? error.code : 'RETURN_OUTCOME_UNCERTAIN';
      await repository.failure(user, current.storeId, current.id, 'refund', true, code, null);
      throw new AppError(
        502,
        code,
        'Something went wrong while returning an order. The refund will not be repeated automatically; check this return before trying again.',
      );
    }
    return complete(user, current);
  }
  async function complete(user: Principal, operation: ReturnOperation) {
    const result = await repository.complete(user, operation.storeId, operation.id);
    // Helpers.return_order (order/views.py:961): inline after the stock and audit writes.
    if (result.completedNow)
      await gateway.returnMail({
        orderId: operation.orderId,
        productId: operation.productId,
        storeId: operation.storeId,
        lineId: operation.lineId,
      });
    return publicReturn(result.operation);
  }
  return {
    /** The per-line eligibility, with every fact the legacy cell branch selection needs. */
    async eligibility(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ExchangeRecoveryScope,
      kind: 'return' | 'exchange',
    ): Promise<LineEligibilityView> {
      const original = await repository.eligibilityScope(user, storeId, orderId, lineId, input);
      let lines = new Map<string, LineEligibility>();
      // ShowOrderDetailsView skips the call for a Shopify store order (order/views.py:378-382).
      if (!(original.storeOrder && original.shopifyOrder))
        try {
          lines = await gateway.orderEligibility(
            orderId,
            storeId,
            await customerToken(context, original.customerId),
          );
        } catch (error) {
          // check_return_exchange_status returns {} on any error: the cells say "Check-in first".
          if (error instanceof AppError && error.code === 'RETURN_CUSTOMER_UNAVAILABLE')
            throw error;
          lines = new Map();
        }
      const current = await repository.eligibilityScope(user, storeId, orderId, lineId, input);
      if (current.binding !== original.binding)
        throw new AppError(
          409,
          'RETURN_ELIGIBILITY_CHANGED',
          'The line changed while checking eligibility.',
        );
      const line = lines.get(lineId) ?? null,
        enabled = current.exchangeFeatureEnabled,
        override = superAdminReturnOverride(
          user.role,
          line?.return ?? null,
          current.lineStatus,
          current.returnStatus,
          context.config.BUSINESS_TIMEZONE,
        );
      const facts: ExchangeCellFacts = {
        variant: current.storeOrder ? 'store' : 'online',
        shopifyOrder: current.shopifyOrder,
        eligibilityLoaded: lines.size > 0,
        productType: current.productType,
        lineStatus: current.lineStatus,
        return: line?.return ?? null,
        exchange: line?.exchange ?? null,
        superAdminReturnOverride: override,
        failedExchange: current.failedExchange,
        checkinStoreId: current.checkinStoreId,
        exchangeFeatureEnabled: enabled,
        operatorRole: user.role,
      };
      const entry = kind === 'exchange' ? line?.exchange : line?.return;
      return {
        orderId,
        lineId,
        kind,
        allowed: Boolean(entry?.status),
        until: entry?.upto ?? null,
        reason: entry?.reason ?? '',
        overrideAvailable: kind === 'return' && override,
        exchangeFeatureEnabled: enabled,
        facts: {
          ...facts,
          returnStatus: current.returnStatus,
          merged: returnExchangeMerged(facts.return, facts.exchange),
        },
        cell: exchangeCell(facts),
      };
    },
    async start(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ReturnInput,
    ) {
      gateway.configured();
      return state.withLine(orderId, lineId, async () => {
        const { operation, replay } = await repository.begin(user, storeId, orderId, lineId, input);
        if (replay) return publicReturn(operation);
        return refund(user, await acceptInbound(user, operation, context));
      });
    },
    async read(user: Principal, storeId: string, id: string) {
      return publicReturn(await repository.read(user, storeId, id));
    },
    async continue(user: Principal, storeId: string, id: string) {
      const initial = await repository.load(user, storeId, id);
      if (initial.kind !== 'return')
        throw new AppError(409, 'RETURN_KIND_MISMATCH', 'This operation is not a refund return.');
      return state.withLine(initial.orderId, initial.lineId, async () => {
        const operation = await repository.load(user, storeId, id);
        if (operation.phase === 'completed') return publicReturn(operation);
        if (operation.phase === 'refund-confirmed') return complete(user, operation);
        if (operation.phase === 'inbound-accepted') {
          gateway.configured();
          return refund(user, operation);
        }
        throw new AppError(
          409,
          'RETURN_REVIEW_REQUIRED',
          'This return needs review. Its warehouse or refund action will not be repeated automatically.',
        );
      });
    },
  };
}
