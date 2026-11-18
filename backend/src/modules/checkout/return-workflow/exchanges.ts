import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { HasCategories } from '../../../db/legacy-schema.js';
import type { Principal } from '../../../domain/access.js';
import { identifier } from '../../../domain/validation.js';
import { AppError } from '../../../domain/errors.js';
import type { CheckoutRepository } from '../contracts.js';
import {
  CheckoutGatewayError,
  type CheckoutEnvironment,
  type CheckoutGateway,
} from '../gateway.js';
import { issueCustomerToken } from '../crypto.js';
import { exchangePayload } from '../payloads.js';
import { orderFinalizer } from '../finalizer.js';
import {
  exchangeFinancialCounter,
  returnInputSchema,
  publicReturn,
  type ExchangeInput,
  type ReturnGateway,
  type ReturnOperation,
} from './contracts.js';
import type { ReturnRepository } from './repository.js';
import { acceptInbound } from './service.js';
import { exchangeStockContract } from './stock-proof.js';
export function exchangeService(
  repository: ReturnRepository,
  customers: CheckoutRepository,
  inbound: ReturnGateway,
  orders: CheckoutGateway,
  signing: CheckoutEnvironment,
  config: Config,
  db: Databases,
  finalize = orderFinalizer(db, config, 'exchange'),
) {
  async function validateReasons(user: Principal, operation: ReturnOperation) {
    try {
      const [category] = await db
        .get('primary')
        .select({ id: HasCategories.cat_id })
        .from(HasCategories)
        .where(eq(HasCategories.prod_id, BigInt(operation.exchange!.parentProductId)))
        .orderBy(asc(HasCategories.id))
        .limit(1);
      if (!category)
        throw new AppError(
          422,
          'EXCHANGE_REASON_UNAVAILABLE',
          'The product exchange reasons are unavailable.',
        );
      const id = z.union([z.string(), z.number()]).transform(String),
        reasons = z
          .array(
            z.object({
              id,
              reason: z.string(),
              sub_reason: z
                .array(z.object({ id, sub_reason: z.string() }))
                .optional()
                .default([]),
            }),
          )
          .parse(await orders.exchangeReasons(String(category.id))),
        selected = reasons.find((reason) => reason.id === operation.input.reasonId);
      if (
        !selected ||
        (selected.sub_reason.length > 0 &&
          !selected.sub_reason.some((reason) => reason.id === operation.input.subReasonId)) ||
        (selected.sub_reason.length === 0 && operation.input.subReasonId)
      )
        throw new AppError(
          422,
          'EXCHANGE_REASON_UNAVAILABLE',
          'Select a current exchange reason and matching sub reason.',
        );
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'EXCHANGE_REASONS_UNAVAILABLE';
      await repository.failure(user, operation.storeId, operation.id, 'inbound', false, code);
      if (error instanceof AppError) throw error;
      throw new AppError(502, code, 'The current exchange reasons could not be confirmed.');
    }
  }
  async function finish(user: Principal, operation: ReturnOperation) {
    const exchange = operation.exchange;
    if (!exchange?.childOrderId)
      throw new AppError(
        409,
        'EXCHANGE_CHILD_UNCONFIRMED',
        'The replacement order has not been confirmed.',
      );
    await repository.assertExchangeFinalizationAvailable(user, operation.storeId, operation.id);
    const operator = await customers.operatorIdentity(user.id);
    if (!operator)
      throw new AppError(
        409,
        'OPERATOR_CUSTOMER_MAPPING_MISSING',
        'Your operator account is not connected to checkout.',
      );
    await finalize(
      {
        storeId: operation.storeId,
        counterId: exchangeFinancialCounter(operation),
        customerId: operation.customerId,
        operatorCustomerId: operator.id,
        salespersonId: exchange.salespersonId,
        lineSalespersons: { [exchange.newProductId]: exchange.salespersonId },
      },
      exchange.childOrderId,
    );
    return publicReturn(await repository.completeExchange(user, operation.storeId, operation.id));
  }
  async function replacement(
    user: Principal,
    initial: ReturnOperation,
    retrySalespersonId?: string,
  ) {
    if (signing.exchangeStockContract !== exchangeStockContract)
      throw new AppError(
        503,
        'EXCHANGE_STOCK_CONTRACT_UNVERIFIED',
        'Replacement inventory confirmation must be verified before recovering an exchange.',
      );
    let operation = initial,
      dispatched = false;
    try {
      if (operation.phase === 'inbound-accepted')
        operation = await repository.restoreExchange(user, operation.storeId, operation.id);
      if (operation.phase === 'replacement-confirmed') return await finish(user, operation);
      const customer = await customers.customer(operation.customerId),
        operator = await customers.operatorIdentity(user.id);
      if (!customer || !operator)
        throw new AppError(
          409,
          'EXCHANGE_IDENTITY_UNAVAILABLE',
          'The customer and operator checkout identities must be available.',
        );
      const token = issueCustomerToken(customer, signing);
      operation = await repository.claimReplacement(
        user,
        operation.storeId,
        operation.id,
        retrySalespersonId,
      );
      const exchange = operation.exchange!;
      dispatched = true;
      const response = z
        .object({ status: z.string(), new_order_id: z.union([z.string(), z.number()]).optional() })
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
              adminCustomerId: operator.id,
              salespersonId: exchange.salespersonId,
            }),
            token,
          ),
        );
      if (response.status !== 'SUCCESS')
        throw new CheckoutGatewayError(
          'EXCHANGE_REPLACEMENT_REJECTED',
          'The replacement service rejected this request.',
          false,
          422,
        );
      const childId = identifier.parse(String(response.new_order_id));
      operation = await repository.replacementConfirmed(
        user,
        operation.storeId,
        operation.id,
        childId,
      );
      return await finish(user, operation);
    } catch (error) {
      const uncertain =
          (error instanceof AppError && error.code === 'EXCHANGE_CHILD_RECONCILIATION_REQUIRED') ||
          (dispatched &&
            (!(error instanceof AppError) ||
              (error instanceof CheckoutGatewayError && error.uncertain))),
        code =
          error instanceof AppError
            ? error.code
            : uncertain
              ? 'EXCHANGE_OUTCOME_UNCERTAIN'
              : 'EXCHANGE_PROCESSING_FAILED';
      await repository.replacementFailure(user, operation.storeId, operation.id, uncertain, code);
      if (error instanceof AppError && !uncertain) throw error;
      throw new AppError(
        502,
        code,
        'The replacement outcome needs review. No replacement will be requested automatically.',
      );
    }
  }
  return {
    async start(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ExchangeInput,
    ) {
      inbound.configured();
      if (signing.exchangeStockContract !== exchangeStockContract)
        throw new AppError(
          503,
          'EXCHANGE_STOCK_CONTRACT_UNVERIFIED',
          'Replacement inventory confirmation must be verified before accepting an exchange.',
        );
      if (!(await customers.operatorIdentity(user.id)))
        throw new AppError(
          409,
          'OPERATOR_CUSTOMER_MAPPING_MISSING',
          'Your operator account is not connected to checkout.',
        );
      const { replacementProductId, salespersonId, ...base } = input,
        request = returnInputSchema.parse({
          ...base,
          refundMode: 'tss-money',
          overrideEligibility: false,
        }),
        { operation, replay } = await repository.begin(user, storeId, orderId, lineId, request, {
          replacementProductId,
          salespersonId,
        });
      if (replay) return publicReturn(operation);
      await validateReasons(user, operation);
      return replacement(
        user,
        await acceptInbound(
          user,
          operation,
          repository,
          customers,
          inbound,
          signing,
          config.BUSINESS_TIMEZONE,
        ),
      );
    },
    async read(user: Principal, storeId: string, id: string) {
      const operation = await repository.read(user, storeId, id);
      if (operation.kind !== 'exchange')
        throw new AppError(404, 'EXCHANGE_NOT_FOUND', 'Exchange was not found.');
      return publicReturn(operation);
    },
    async reconcile(user: Principal, storeId: string, id: string) {
      return publicReturn(await repository.reconcileReplacement(user, storeId, id));
    },
    async continue(user: Principal, storeId: string, id: string) {
      const operation = await repository.read(user, storeId, id);
      if (operation.kind !== 'exchange')
        throw new AppError(404, 'EXCHANGE_NOT_FOUND', 'Exchange was not found.');
      if (operation.phase === 'completed') return publicReturn(operation);
      if (
        !['inbound-accepted', 'old-item-restored', 'replacement-confirmed'].includes(
          operation.phase,
        )
      )
        throw new AppError(
          409,
          'EXCHANGE_REVIEW_REQUIRED',
          'This exchange needs reconciliation or an explicit retry after a confirmed rejection.',
        );
      return replacement(user, operation);
    },
    async retry(user: Principal, storeId: string, id: string, salespersonId: string) {
      const operation = await repository.read(user, storeId, id);
      if (operation.kind !== 'exchange' || operation.phase !== 'replacement-rejected')
        throw new AppError(
          409,
          'EXCHANGE_REVIEW_REQUIRED',
          'Only a confirmed replacement rejection can be retried. Uncertain calls require reconciliation.',
        );
      return replacement(user, operation, salespersonId);
    },
  };
}
