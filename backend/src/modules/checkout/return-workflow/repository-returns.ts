import { and, asc, desc, eq, like, or } from 'drizzle-orm';
import {
  AmountToBeRefundedLog,
  Comments,
  HasProduct,
  Order,
  PosExchangeLog,
  PosTransactionLog,
  ReturnOrder,
  ReversePickupReason,
  StoreDayClose,
} from '../../../db/legacy-schema.js';
import { requireRole, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { financialYear } from '../finalizer.js';
import { exchangeRetryable } from '../returns.js';
import { wireId } from '../payloads.js';
import { pythonFloatRepr } from '../../../domain/python-compat.js';
import { forceReturnRefusal } from './exchange-cell.js';
import type { ReturnInput, ReturnOperation, InboundReturn } from './contracts.js';
import { fingerprint } from './state.js';
import {
  CommittedFailure,
  STALE_PENDING_MINUTES,
  RETURNED_OR_EXCHANGED,
  type ReturnRepositoryCore,
} from './repository-core.js';

/**
 * The return lifecycle: begin, inbound data, acceptance, the refund claim and completion.
 */
export function returnLifecycleOperations(core: ReturnRepositoryCore) {
  const {
    db,
    options,
    state,
    now,
    timestamp,
    stamp,
    minutesSince,
    context,
    refused,
    guardFacts,
    assertExchangeOffered,
    load,
    owned,
    restore,
    exchangeSelection,
    phaseOneCommitted,
    exchangeLog,
    returnWindow,
    assertNoActiveOperation,
  } = core;
  return {
    /**
     * Validates and records a new return/exchange (`AjaxProductReturnView` / `AjaxProductExchangeView`
     * up to the warehouse call). The caller holds the line lock.
     */
    async begin(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      input: ReturnInput,
      exchange?: { replacementProductId: string; salespersonId: string },
    ): Promise<{ operation: ReturnOperation; replay: boolean }> {
      const hash = fingerprint(exchange ? 'exchange.create' : 'return.create', {
        storeId,
        orderId,
        lineId,
        input,
        ...(exchange ? { exchange } : {}),
      });
      const previous = await state.readOperation(input.operationId);
      if (previous) {
        if (
          previous.storeId !== storeId ||
          previous.orderId !== orderId ||
          previous.lineId !== lineId ||
          previous.operatorId !== user.id ||
          previous.requestHash !== hash
        )
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This return key was used with different data.',
          );
        return { operation: previous, replay: true };
      }
      if (input.saleable && !options.inventoryProcedureVerified)
        throw new AppError(
          503,
          'RETURN_INVENTORY_UNVERIFIED',
          'The deployed inventory procedure must be verified before restoring saleable stock.',
        );
      if (input.overrideEligibility) requireRole(user, [1]);
      if (!exchange) await assertNoActiveOperation(orderId, lineId);
      const result = await db.get('writer').transaction(async (tx) => {
        const scope = await context(tx, user, storeId, orderId, lineId, input.counterId);
        // S35: the exchange and force-return buttons are template-gated in legacy; the server
        // gives the same outcome before anything is written.
        const guard = exchange
          ? await assertExchangeOffered(tx, user.id, orderId, scope.line.product, false)
          : await guardFacts(tx, user.id, orderId, scope.line.product);
        if (!exchange && input.clickType === 'extreme') {
          const refusal = forceReturnRefusal({ ...guard, lineStatus: scope.line.status });
          if (refusal) throw refused(refusal);
        }
        const exchangeInitiated = scope.line.status === 'EXCHANGE_INITIATED';
        if (
          !(scope.line.status === 'DELIVERED' && scope.line.return_status === 0) &&
          !(exchange && exchangeInitiated)
        )
          throw new AppError(
            409,
            'RETURN_LINE_INELIGIBLE',
            'This line is no longer available for a new return.',
          );
        // return_processed checks the delivery, window and unrefunded amount before anything else.
        if (!exchange) {
          const failure = await returnWindow(
            tx,
            orderId,
            lineId,
            scope.line.product,
            input.clickType,
          );
          if (failure) throw failure;
        }
        const [reason] = await tx
          .select({ id: ReversePickupReason.id })
          .from(ReversePickupReason)
          .where(eq(ReversePickupReason.id, BigInt(input.reasonId)))
          .limit(1);
        if (
          (!reason && !exchange) ||
          BigInt(input.reasonId) > 2147483647n ||
          BigInt(storeId) > 2147483647n ||
          BigInt(input.subReasonId || '0') > 2147483647n
        )
          throw new AppError(422, 'RETURN_REASON_UNAVAILABLE', 'Please select correct reason');
        if (
          input.refundMode === 'cash' &&
          scope.order.paymentMethod === 3n &&
          !(user.role === 1 && scope.order.parentId > 0n && !scope.order.parentExpress)
        )
          throw new AppError(
            403,
            'CASH_REFUND_NOT_PERMITTED',
            'This prepaid line is eligible for wallet refund only.',
          );
        if (scope.line.qty < 1n || scope.line.qty > 2147483647n)
          throw new AppError(
            409,
            'RETURN_QUANTITY_INVALID',
            'This line has no supported returnable quantity.',
          );
        const date = timestamp();
        let exchangeState: ReturnOperation['exchange'] = null;
        if (exchange) {
          // order/views.py:1013-1050, in the same order.
          const log = await exchangeLog(tx, orderId, lineId);
          if (log) {
            if (log.status === 'SUCCESS')
              throw new AppError(
                409,
                'EXCHANGE_ALREADY_COMPLETED',
                'This item has already been exchanged.',
              );
            if (log.status === 'PENDING' && minutesSince(log.updated_at) < STALE_PENDING_MINUTES)
              throw new AppError(
                409,
                'EXCHANGE_IN_PROGRESS',
                'An exchange for this item is already in progress.',
              );
            const committed = Boolean(await phaseOneCommitted(tx, log));
            if (exchangeRetryable(scope.line.status, committed))
              throw new AppError(
                409,
                'EXCHANGE_RETRY_REQUIRED',
                'A previous exchange attempt for this item failed. Please refresh the page and use the retry button.',
              );
            if (committed)
              throw new AppError(
                409,
                'EXCHANGE_ALREADY_RETURNED',
                'This item has already been returned or refunded. Please contact tech support.',
              );
          }
          const selected = await exchangeSelection(tx, scope, exchange, false);
          if (
            [
              orderId,
              lineId,
              storeId,
              String(scope.line.product),
              selected.newProductId,
              selected.parentProductId,
              user.id,
              input.counterId,
              exchange.salespersonId,
            ].some((value) => BigInt(value) > 2147483647n)
          )
            throw new AppError(
              409,
              'EXCHANGE_IDENTIFIER_UNSUPPORTED',
              'This exchange exceeds the supported legacy ledger identifiers.',
            );
          const values = {
            order_id: Number(orderId),
            has_prod_id: Number(lineId),
            old_prod_id: Number(scope.line.product),
            old_size: selected.oldSize,
            new_prod_id: Number(selected.newProductId),
            new_size: selected.newSize,
            exchange_parent_prod_id: Number(selected.parentProductId),
            store_id: Number(storeId),
            counter_id: Number(input.counterId),
            staff_user_id: Number(user.id),
            reason_id: Number(input.reasonId),
            sub_reason_id: Number(input.subReasonId || '0'),
            comment: input.comment,
            saleable: input.saleable,
            status: 'PENDING',
            updated_at: date,
          };
          if (log) await tx.update(PosExchangeLog).set(values).where(eq(PosExchangeLog.id, log.id));
          else
            await tx.insert(PosExchangeLog).values({
              ...values,
              new_order_id: 0,
              retry_count: 0,
              last_error: null,
              created_at: date,
            });
          const saved = log ?? (await exchangeLog(tx, orderId, lineId));
          if (!saved)
            throw new AppError(
              503,
              'EXCHANGE_LEDGER_UNAVAILABLE',
              'The exchange ledger could not be recorded.',
            );
          exchangeState = { ...selected, logId: String(saved.id), childOrderId: null };
          // An exchange already marked on the line was approved once (order/views.py:1124-1126).
          const failure = await returnWindow(
            tx,
            orderId,
            lineId,
            scope.line.product,
            exchangeInitiated ? 'extreme' : 'normal',
          );
          if (failure) {
            await tx
              .update(PosExchangeLog)
              .set({
                status: 'FAILED_NEEDS_MANUAL_FIX',
                last_error: failure.message,
                updated_at: timestamp(),
              })
              .where(eq(PosExchangeLog.id, saved.id));
            return new CommittedFailure(failure);
          }
        }
        const operation: ReturnOperation = {
          id: input.operationId,
          kind: exchange ? 'exchange' : 'return',
          exchange: exchangeState,
          operatorId: user.id,
          storeId,
          orderId,
          lineId,
          productId: String(scope.line.product),
          customerId: String(scope.order.customerId),
          quantity: Number(scope.line.qty),
          guard: { variant: guard.variant, productType: guard.productType },
          input,
          requestHash: hash,
          phase: 'inbound-dispatching',
          uncertainStage: null,
          creditNote: null,
          returnAmount: null,
          returnAmountRepr: null,
          errorCode: null,
          message: null,
          createdAt: date,
          updatedAt: date,
        };
        return operation;
      });
      if (result instanceof CommittedFailure) throw result.error;
      if (!(await state.createOperation(result)))
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This return key is already in use.');
      return { operation: result, replay: false };
    },
    async inboundData(user: Principal, storeId: string, id: string): Promise<InboundReturn> {
      const operation = await load(user, storeId, id);
      return db.get('writer').transaction(async (tx) => {
        const { store, order, line } = await owned(tx, user, operation),
          [reason] = await tx
            .select({ reason: ReversePickupReason.reason })
            .from(ReversePickupReason)
            .where(eq(ReversePickupReason.id, BigInt(operation.input.reasonId)))
            .limit(1);
        const date = now();
        return {
          locationCode: store.locationCode,
          orderId: operation.orderId,
          trackingNumber: line.awb || wireId(operation.orderId),
          returnDate: `${String(date.day).padStart(2, '0')}/${String(date.month).padStart(2, '0')}/${date.year} ${String(date.hour).padStart(2, '0')}:${String(date.minute).padStart(2, '0')}:${String(date.second).padStart(2, '0')}`,
          customerName: order.name,
          address1: order.address1,
          address2: order.address2,
          state: String(order.state),
          city: order.city,
          pincode: order.pincode,
          remarks: operation.input.comment
            ? `${reason?.reason || ''}:${operation.input.comment}`
            : '',
          productId: operation.productId,
          lineId: operation.lineId,
          quantity: operation.quantity,
          reason: reason?.reason || '',
          exchange: operation.kind === 'exchange',
        };
      });
    },
    /** `add_to_return_orders`, `has_product_and_order_update`, `add_to_comment` (calculations.py:189-250). */
    async accepted(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      const next = await db.get('writer').transaction(async (tx) => {
        const { store, line } = await owned(tx, user, operation);
        if (operation.phase !== 'inbound-dispatching')
          throw new AppError(
            409,
            'RETURN_PHASE_CHANGED',
            'The return phase changed. Review its current status.',
          );
        const [reason] = await tx
            .select({ reason: ReversePickupReason.reason })
            .from(ReversePickupReason)
            .where(eq(ReversePickupReason.id, BigInt(operation.input.reasonId)))
            .limit(1),
          lines = await tx
            .select({ id: HasProduct.id, status: HasProduct.status })
            .from(HasProduct)
            .where(eq(HasProduct.order, BigInt(operation.orderId))),
          // calculations.py:112-117: count returned/exchanged lines including this one.
          done = lines.filter((row) => RETURNED_OR_EXCHANGED.includes(row.status || '')).length,
          orderStatus = lines.length - 1 === done ? 6 : 37;
        // Legacy helpers.py:2205,2284,2299 formats Store.location_code (nullable) in
        // f-strings, so a NULL code becomes 'None'.
        const storeCode = store.locationCode ?? 'None',
          fy = financialYear(timestamp()),
          [last] = await tx
            .select({ number: ReturnOrder.credit_note_no })
            .from(ReturnOrder)
            .where(
              and(
                eq(ReturnOrder.store_id, Number(storeId)),
                or(
                  // Django `startswith` escapes `\ % _`: the store code matches literally.
                  like(
                    ReturnOrder.credit_note_no,
                    `${storeCode.replace(/[\\%_]/g, '\\$&')}/${fy}/CN/%`,
                  ),
                  like(
                    ReturnOrder.credit_note_no,
                    `${storeCode.replace(/[\\%_]/g, '\\$&')}${fy}CN%`,
                  ),
                ),
              ),
            )
            .orderBy(desc(ReturnOrder.credit_note_no))
            .limit(1)
            .for('update'),
          sequence = last?.number ? Number(/(\d+)$/.exec(last.number)?.[1] || 0) + 1 : 1,
          creditNote = `${storeCode}${fy}CN${String(sequence).padStart(5, '0')}`,
          date = timestamp();
        await tx.insert(ReturnOrder).values({
          order_status: orderStatus,
          order_id: BigInt(operation.orderId),
          prod_id: BigInt(operation.productId),
          sub_prod_id: line.sub_prod_id,
          qty: operation.quantity,
          received: 0,
          reason_id: Number(operation.input.reasonId),
          sub_reason_id: Number(operation.input.subReasonId || '0'),
          store_id: Number(storeId),
          other_reason: '',
          comment: reason?.reason || '',
          created_at: date,
          updated_at: date,
          has_product_id: BigInt(operation.lineId),
          credit_note_no: creditNote,
        });
        await tx
          .update(HasProduct)
          .set({
            return_status: operation.kind === 'exchange' ? 1 : 33,
            status: operation.kind === 'exchange' ? 'EXCHANGE_INITIATED' : 'PRODUCT_RETURNED',
            amount_refunded_mode: 0,
            return_mode: operation.kind === 'exchange' ? 5 : 3,
            return_request_date_time: date,
          })
          .where(eq(HasProduct.id, line.id));
        if (operation.kind !== 'exchange')
          await tx
            .update(Order)
            .set({
              order_statuses: BigInt(orderStatus),
              payment_statuses: orderStatus === 6 ? 5n : 9n,
            })
            .where(eq(Order.id, BigInt(operation.orderId)));
        await tx.insert(Comments).values({
          order_id: BigInt(operation.orderId),
          status_id: BigInt(orderStatus),
          comment:
            operation.kind === 'exchange'
              ? 'Store exchange initiated by POS dashbaord'
              : 'Store return initiated by POS dashbaord',
          notify: 1,
          user_id: 0n,
          package_details: '',
          has_product_id: BigInt(operation.lineId),
          prod_id: BigInt(operation.productId),
          created_at: date,
          updated_at: date,
        });
        return stamp({ ...operation, phase: 'inbound-accepted', creditNote });
      });
      return state.saveOperation(next);
    },
    async claimRefund(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      const next = await db.get('writer').transaction(async (tx) => {
        const { order } = await owned(tx, user, operation);
        if (operation.kind !== 'return')
          throw new AppError(409, 'RETURN_KIND_MISMATCH', 'This operation is not a refund return.');
        if (operation.phase !== 'inbound-accepted')
          throw new AppError(
            409,
            'RETURN_REFUND_ALREADY_DISPATCHED',
            'The refund was already dispatched or needs review.',
          );
        if (operation.input.overrideEligibility) requireRole(user, [1]);
        if (
          operation.input.refundMode === 'cash' &&
          order.paymentMethod === 3n &&
          !(user.role === 1 && order.parentId > 0n && !order.parentExpress)
        )
          throw new AppError(
            403,
            'CASH_REFUND_NOT_PERMITTED',
            'This prepaid line is eligible for wallet refund only.',
          );
        return stamp({ ...operation, phase: 'refund-dispatching' });
      });
      return state.saveOperation(next);
    },
    async refundConfirmed(
      user: Principal,
      storeId: string,
      id: string,
      returnAmount: string,
      returnAmountRepr: string,
    ) {
      const operation = await load(user, storeId, id);
      if (operation.phase !== 'refund-dispatching')
        throw new AppError(
          409,
          'RETURN_PHASE_CHANGED',
          'The return phase changed. Review its current status.',
        );
      return state.saveOperation(
        stamp({
          ...operation,
          phase: 'refund-confirmed',
          returnAmount,
          returnAmountRepr,
        }),
      );
    },
    /** order/views.py:938-941: "Already refunded" ends the request without stock or audit. */
    async alreadyRefunded(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      return state.saveOperation(
        stamp({
          ...operation,
          phase: 'rejected',
          uncertainStage: null,
          errorCode: 'RETURN_ALREADY_REFUNDED',
          message: 'Already refunded',
        }),
      );
    },
    /** Stock, `return_transaction_logger` and `mark_stale` (order/views.py:948-966). */
    async complete(user: Principal, storeId: string, id: string) {
      const operation = await load(user, storeId, id);
      if (operation.kind !== 'return')
        throw new AppError(409, 'RETURN_KIND_MISMATCH', 'This operation is not a refund return.');
      if (operation.phase === 'completed') return { operation, completedNow: false };
      if (operation.phase !== 'refund-confirmed' || operation.returnAmount === null)
        throw new AppError(
          409,
          'RETURN_REFUND_UNCONFIRMED',
          'The refund must be confirmed before returning stock.',
        );
      const next = await db.get('writer').transaction(async (tx) => {
        const { store } = await owned(tx, user, operation);
        await restore(tx, user, operation);
        // helpers.py:442: filter(order_id, prod_id).first() — no line filter.
        const [ledger] = await tx
            .select()
            .from(AmountToBeRefundedLog)
            .where(
              and(
                eq(AmountToBeRefundedLog.order_id, BigInt(operation.orderId)),
                eq(AmountToBeRefundedLog.prod_id, BigInt(operation.productId)),
              ),
            )
            .orderBy(asc(AmountToBeRefundedLog.id))
            .limit(1),
          [order] = await tx
            .select({ status: Order.order_statuses, paymentStatus: Order.payment_statuses })
            .from(Order)
            .where(eq(Order.id, BigInt(operation.orderId)))
            .limit(1);
        if (!ledger || !order)
          throw new AppError(409, 'RETURN_LEDGER_UNAVAILABLE', 'The return ledger is unavailable.');
        const date = timestamp(),
          amountRepr = operation.returnAmountRepr ?? operation.returnAmount!;
        await tx.insert(PosTransactionLog).values({
          order_id: BigInt(operation.orderId),
          store_id: BigInt(storeId),
          order_status: order.status ?? 0n,
          payment_status: order.paymentStatus ?? 0n,
          user_id: 0n,
          pos_user_id: BigInt(user.id),
          pay_dict:
            `{'tss point refunded': ${pythonFloatRepr(ledger.tss_point_used)}, ` +
            `'tss money refunded': ${pythonFloatRepr(ledger.tss_money_used)}, ` +
            `'gift voucher amount refunded': ${pythonFloatRepr(ledger.gift_voucher_amount)}, ` +
            `'${operation.input.refundMode === 'cash' ? 'pay amt refunded into cash' : 'pay amt refunded into tss money'}': ${amountRepr}, ` +
            `'total amount refunded': ${pythonFloatRepr(ledger.amount_to_be_refunded + ledger.tss_point_used)}}`,
          comment:
            `Product ID : ${operation.productId}, ${operation.quantity} Quantity Return to ${store.name}`.slice(
              0,
              255,
            ),
          created_at: date,
          updated_at: date,
        });
        if (operation.input.refundMode === 'cash')
          await tx
            .update(StoreDayClose)
            .set({
              status: 'STALE',
              stale_at: date,
              stale_reason: 'REFUND',
              stale_trigger_ref: operation.orderId,
              updated_at: date,
            })
            .where(
              and(
                eq(StoreDayClose.store_id, Number(storeId)),
                eq(StoreDayClose.close_date, now().toPlainDate().toString()),
                eq(StoreDayClose.status, 'CLOSED'),
              ),
            );
        return stamp({
          ...operation,
          phase: 'completed',
          errorCode: null,
          message: 'Product return request processed.',
        });
      });
      return { operation: await state.saveOperation(next), completedNow: true };
    },
  };
}
