import { z } from 'zod';
import type { Principal } from '../../../domain/access.js';
import { identifier } from '../../../domain/validation.js';
import { AppError } from '../../../domain/errors.js';
import { CheckoutGatewayError, type CheckoutGateway } from '../gateway.js';
import { issueCustomerToken } from '../crypto.js';
import { exchangePayload } from '../payloads.js';
import { currentRequestTrace } from '../../../observability/context.js';
import {
  exchangeFinancialCounter,
  publicReturn,
  type ExchangeInput,
  type ReturnOperation,
} from './contracts.js';
import { acceptInbound, type ReturnServiceContext } from './service.js';

/**
 * `AjaxProductExchangeView` (order/views.py:978-1313): return leg, stock, API-v2 `pos/exchange`,
 * then the delivered child-order bookkeeping. A failed replacement leaves the tracking row
 * FAILED_NEEDS_MANUAL_FIX for an explicit retry; nothing is retried in the background.
 */
export function exchangeService(context: ReturnServiceContext, orders: CheckoutGateway) {
  const { repository, gateway, customers } = context,
    state = repository.state;
  async function finish(user: Principal, operation: ReturnOperation) {
    const result = await repository.completeExchange(user, operation.storeId, operation.id, () => {
      const trace = currentRequestTrace();
      context.log?.warn(
        {
          module: 'checkout',
          resource: 'exchange-operation',
          eventId: 'checkout.exchange-operation.invoice-failed',
          requestId: trace?.requestId ?? null,
          userId: trace?.userId ?? null,
        },
        'Invoice generation for the exchange child order failed',
      );
    });
    // order/views.py:1270-1271: the exchange email only on the first completion.
    if (!result.alreadyFinished && result.operation.exchange?.childOrderId)
      await gateway.exchangeMail({
        orderId: result.operation.exchange.childOrderId,
        productId: result.operation.exchange.newProductId,
        lineId: result.replacementLineId,
      });
    return publicReturn(result.operation);
  }
  async function replacement(
    user: Principal,
    initial: ReturnOperation,
    retrySalespersonId?: string,
  ) {
    let operation = initial;
    if (operation.phase === 'inbound-accepted')
      operation = await repository.restoreExchange(user, operation.storeId, operation.id);
    if (operation.phase === 'replacement-confirmed') return finish(user, operation);
    const customer = await customers.customer(operation.customerId);
    if (!customer)
      throw new AppError(
        409,
        'RETURN_CUSTOMER_UNAVAILABLE',
        'The order customer could not be confirmed.',
      );
    // The order customer's token; staff identity travels as admin_user_id (views.py:1180-1184).
    const token = issueCustomerToken(customer, context.signing);
    operation = await repository.claimReplacement(
      user,
      operation.storeId,
      operation.id,
      retrySalespersonId,
    );
    const exchange = operation.exchange!;
    // views.py:1155-1167: a missing MUser mapping is alerted and proceeds with admin_user_id=0.
    const operator = await customers.operatorIdentity(user.id);
    if (!operator)
      await gateway.slack({
        message: `⚠️ POS Exchange: no staff mapping found for pos_admin_id=${user.id} | order_id=${operation.orderId} has_prod_id=${operation.lineId} store_id=${operation.storeId} — proceeding with admin_user_id=0`,
        storeId: operation.storeId,
        staffUser: user.name,
        storeSlackUrl: await repository.storeSlackUrl(operation.storeId),
      });
    let message: string | null = null,
      childId: string | null = null;
    try {
      const response = z
        .object({
          status: z.string().optional(),
          new_order_id: z.union([z.string(), z.number()]).optional(),
          message: z.string().max(1024).optional(),
        })
        .passthrough()
        .parse(
          await orders.api(
            'pos/exchange',
            exchangePayload({
              orderId: operation.orderId,
              lineId: operation.lineId,
              oldProductId: operation.productId,
              newProductId: exchange.newProductId,
              parentId: exchange.parentProductId,
              size: exchange.newSize,
              storeId: operation.storeId,
              counterId: exchangeFinancialCounter(operation),
              saleable: operation.input.saleable,
              reasonId: operation.input.reasonId,
              subReasonId: operation.input.subReasonId || null,
              comment: operation.input.comment,
              adminCustomerId: operator?.id ?? '0',
              salespersonId: exchange.salespersonId,
            }),
            token,
          ),
        );
      if (response.status === 'SUCCESS') {
        const parsed = identifier.safeParse(String(response.new_order_id ?? ''));
        if (parsed.success) childId = parsed.data;
        else message = 'Exchange service returned an unexpected response.';
      } else message = response.message || 'Exchange order creation failed.';
    } catch (error) {
      // call_pos_exchange_api (order/libs/calculations.py:420-438).
      message =
        error instanceof CheckoutGatewayError && !error.uncertain
          ? 'Exchange order creation failed.'
          : error instanceof z.ZodError
            ? 'Exchange service returned an unexpected response.'
            : 'Could not reach exchange service. Please retry or contact support.';
    }
    if (childId === null) {
      const failed = await repository.replacementFailure(
        user,
        operation.storeId,
        operation.id,
        message ?? 'Exchange order creation failed.',
      );
      await gateway.slack({
        message: `🚨 POS Exchange FAILED (needs manual fix) | order_id=${operation.orderId} has_prod_id=${operation.lineId} store_id=${operation.storeId} retry_count=${failed.retryCount ?? 0} | Old item already taken from customer, no replacement order created | Error: ${message}`,
        storeId: operation.storeId,
        staffUser: user.name,
        storeSlackUrl: await repository.storeSlackUrl(operation.storeId),
      });
      throw new AppError(
        502,
        'EXCHANGE_REPLACEMENT_FAILED',
        `Item returned, but the replacement order could not be created: ${message}`,
      );
    }
    operation = await repository.replacementConfirmed(
      user,
      operation.storeId,
      operation.id,
      childId,
    );
    return finish(user, operation);
  }
  return {
    async start(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ExchangeInput,
    ) {
      gateway.configured();
      const { replacementProductId, salespersonId, ...base } = input;
      return state.withLine(orderId, lineId, async () => {
        const { operation, replay } = await repository.begin(
          user,
          storeId,
          orderId,
          lineId,
          { ...base, refundMode: 'tss-money', overrideEligibility: false, clickType: 'normal' },
          { replacementProductId, salespersonId },
        );
        if (replay) return publicReturn(operation);
        return replacement(user, await acceptInbound(user, operation, context));
      });
    },
    async read(user: Principal, storeId: string, id: string) {
      const operation = await repository.read(user, storeId, id);
      if (operation.kind !== 'exchange')
        throw new AppError(404, 'EXCHANGE_NOT_FOUND', 'Exchange was not found.');
      return publicReturn(operation);
    },
    async continue(user: Principal, storeId: string, id: string) {
      const initial = await repository.load(user, storeId, id);
      if (initial.kind !== 'exchange')
        throw new AppError(404, 'EXCHANGE_NOT_FOUND', 'Exchange was not found.');
      return state.withLine(initial.orderId, initial.lineId, async () => {
        const operation = await repository.load(user, storeId, id);
        if (operation.phase === 'completed') return publicReturn(operation);
        if (
          !['inbound-accepted', 'old-item-restored', 'replacement-confirmed'].includes(
            operation.phase,
          )
        )
          throw new AppError(
            409,
            'EXCHANGE_REVIEW_REQUIRED',
            'This exchange needs review or an explicit retry after a failed replacement.',
          );
        return replacement(user, operation);
      });
    },
    /** The legacy retry button (retry=1): stored picks, a fresh salesperson, same store only. */
    async retry(user: Principal, storeId: string, id: string, salespersonId: string) {
      const initial = await repository.load(user, storeId, id);
      if (initial.kind !== 'exchange')
        throw new AppError(404, 'EXCHANGE_NOT_FOUND', 'Exchange was not found.');
      return state.withLine(initial.orderId, initial.lineId, async () => {
        const operation = await repository.load(user, storeId, id);
        if (operation.phase !== 'replacement-rejected')
          throw new AppError(
            409,
            'EXCHANGE_REVIEW_REQUIRED',
            'This item is no longer awaiting an exchange. Please refresh the page.',
          );
        return replacement(user, operation, salespersonId);
      });
    },
  };
}
