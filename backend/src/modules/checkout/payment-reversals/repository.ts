import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  Comments,
  GiftVoucher,
  HasProduct,
  Order,
  OrderStore,
  PosTransactionLog,
  ReturnOrder,
  Store,
} from '../../../db/legacy-schema.js';
import { retryTransaction } from '../../../db/retry.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { amount, minorUnits } from '../../../domain/money.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { operationHash } from '../crypto.js';
import { pendingOrderCancellations } from '../cancellations/schema.js';
import { cashRefundAudit } from '../refund-audit.js';
import { readOrderPaymentEvidence } from '../payments/repository.js';
import { paymentAttempts, paymentOutbox } from '../payments/schema.js';
import {
  assertCheckoutProjection,
  assertCheckoutProjectionReady,
  checkoutHeaderHashSql,
  checkoutLineHashSql,
  type CheckoutProjectionConfiguration,
} from '../projection.js';
import {
  assertRefundAllocationReady,
  type RefundAllocationConfiguration,
} from '../refund-allocation.js';
import { returnOperations } from '../return-workflow/schema.js';
import {
  paymentCorrectionFinanceContract,
  paymentReversalContract,
  paymentReversalInputSchema,
  paymentReversalReceiptSchema,
  type PaymentReversalContext,
  type PaymentReversalInput,
  type PaymentReversalOptions,
} from './contracts.js';
import {
  appendCorrectionCash,
  managedCorrectionOrder,
  managedOrderHash,
  originalPaymentHash,
  paymentCorrectionEvidence,
  staleCorrectionClose,
  verifiedReversal,
} from './evidence.js';
import {
  paymentCorrectionOrders,
  paymentReversals,
  paymentReversalLineAuthority,
} from './schema.js';

type Transaction = AdministrationTransaction;
export interface PaymentReversalRepositoryOptions extends PaymentReversalOptions {
  hashSecret: string;
  projection: CheckoutProjectionConfiguration & RefundAllocationConfiguration;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string | undefined,
    tx: Transaction,
  ) => Promise<void>;
  clock?: () => Temporal.Instant;
}
const refused = (code: string) =>
  new AppError(
    409,
    code,
    'The original payment needs reconciliation before its recorded settlement can be corrected.',
  );
const unusedDate = (value: string | null) =>
  value === null || value === '' || value.startsWith('0000-00-00');
export function paymentReversalRepository(
  db: Databases,
  config: Config,
  options: PaymentReversalRepositoryOptions,
) {
  const checks = checkInService(db, config),
    checkIn =
      options.assertCheckIn ??
      ((userId, storeId, counterId, tx) => checks.assertCheckIn(userId, storeId, counterId, tx)),
    corrections = paymentCorrectionEvidence(options.hashSecret),
    now = () =>
      (options.clock?.() ?? Temporal.Now.instant())
        .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' '),
    transact = <T>(fn: (tx: Transaction) => Promise<T>) =>
      retryTransaction(() => db.get('writer').transaction(fn));
  async function scope(tx: Transaction, user: Principal, storeId: string, orderId: string) {
    requireStore(user, storeId);
    await checkIn(user.id, storeId, undefined, tx);
    await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3]);
    const [store] = await tx
      .select({ id: Store.id })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .limit(1)
      .for('update');
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store was not found.');
    const rows = await tx
      .select({
        id: Order.id,
        method: Order.payment_methods,
        paymentStatus: Order.payment_statuses,
        status: Order.order_statuses,
        createdAt: Order.created_at,
        payable: Order.pay_amt,
        headerHash: sql<string>`${sql.raw(checkoutHeaderHashSql)}`,
        shipDate: Order.ship_date,
        shipFlag: Order.ship_flag,
        tracking: Order.shiplabel_tracking_id,
        courier: Order.courier,
        returnDate: Order.ret_ex_request_date,
        mappingId: OrderStore.id,
        counterId: OrderStore.counter,
        manuallyPaid: OrderStore.is_manually_paid,
        transactionId: OrderStore.transaction_id,
        cash: OrderStore.offline_payment,
        cashReceived: OrderStore.offline_payment_recieved,
        online: OrderStore.online_payment,
        other: OrderStore.online_other_payment,
        offline: OrderStore.is_offline_order,
        shopify: OrderStore.is_shopify_order,
      })
      .from(OrderStore)
      .innerJoin(Order, eq(Order.id, OrderStore.order))
      .where(and(eq(Order.id, BigInt(orderId)), eq(OrderStore.store, BigInt(storeId))))
      .limit(2)
      .for('update');
    if (rows.length !== 1)
      throw new AppError(404, 'ORDER_NOT_FOUND', 'A unique order was not found in this store.');
    const order = rows[0]!;
    await checkIn(user.id, storeId, String(order.counterId), tx);
    return order;
  }
  async function evaluate(
    tx: Transaction,
    storeId: string,
    orderId: string,
    order: Awaited<ReturnType<typeof scope>>,
  ) {
    if (
      options.contract !== paymentReversalContract ||
      options.financeContract !== paymentCorrectionFinanceContract ||
      options.hashSecret.length < 32
    )
      throw new AppError(
        503,
        'PAYMENT_REVERSAL_CONTRACT_UNVERIFIED',
        'Verify the payment correction and cash reconciliation integration before recording a correction.',
      );
    assertCheckoutProjectionReady(options.projection);
    assertRefundAllocationReady(options.projection);
    if (
      order.method !== 14n ||
      order.paymentStatus !== 4n ||
      order.status !== 3n ||
      !order.manuallyPaid ||
      order.offline ||
      order.shopify ||
      minorUnits(String(order.payable)) <= 0n ||
      minorUnits(order.cash) !== minorUnits(String(order.payable)) ||
      minorUnits(order.cashReceived) < minorUnits(order.cash) ||
      minorUnits(order.online) !== 0n ||
      minorUnits(order.other) !== 0n
    )
      throw refused('PAYMENT_REVERSAL_CASH_PROOF_REQUIRED');
    if (
      !unusedDate(order.shipDate) ||
      !unusedDate(order.returnDate) ||
      !['', '0'].includes(order.shipFlag) ||
      order.tracking !== '' ||
      order.courier !== 0n
    )
      throw refused('PAYMENT_REVERSAL_FULFILMENT_REVIEW_REQUIRED');
    const [cancelled] = await tx
      .select({ orderId: pendingOrderCancellations.orderId })
      .from(pendingOrderCancellations)
      .where(eq(pendingOrderCancellations.orderId, orderId))
      .limit(1);
    if (cancelled) throw refused('PAYMENT_REVERSAL_IMMUTABLE_SALE_REVIEW_REQUIRED');
    const [returned] = await tx
      .select({ id: ReturnOrder.id })
      .from(ReturnOrder)
      .where(eq(ReturnOrder.order_id, BigInt(orderId)))
      .limit(1);
    if (returned) throw refused('PAYMENT_REVERSAL_RETURN_REVIEW_REQUIRED');
    await assertCheckoutProjection(tx, { orderId, storeId, counterId: String(order.counterId) });
    const history = await readOrderPaymentEvidence(tx, orderId, options.hashSecret),
      attempts = await corrections.effective(tx, history.attempts),
      active = attempts.filter(
        (attempt) => !['failed', 'cancelled', 'reversed'].includes(attempt.status),
      );
    if (history.completed || history.ambiguous || history.candidates.length || active.length !== 1)
      throw refused('PAYMENT_REVERSAL_PROVIDER_REVIEW_REQUIRED');
    if (
      attempts.some(
        (attempt) =>
          ['failed', 'cancelled'].includes(attempt.status) &&
          (minorUnits(attempt.cashAmount) > 0n || minorUnits(attempt.cashReceived) > 0n),
      )
    )
      throw refused('PAYMENT_REVERSAL_UNACCOUNTED_CASH');
    const original = active[0]!;
    if (
      original.status !== 'paid' ||
      original.channel !== 'cash' ||
      original.legacySource ||
      original.machineId !== null ||
      original.providerReference !== original.transactionId ||
      original.busyOperationId !== null ||
      original.storeId !== storeId ||
      original.counterId !== String(order.counterId) ||
      original.transactionId !== order.transactionId ||
      minorUnits(original.cashAmount) !== minorUnits(order.cash) ||
      minorUnits(original.cashReceived) !== minorUnits(order.cashReceived) ||
      minorUnits(original.onlineAmount) !== 0n
    )
      throw refused('PAYMENT_REVERSAL_ORIGINAL_FUNDS_UNPROVED');
    const lines = await tx
      .select({
        id: HasProduct.id,
        productId: HasProduct.product,
        quantity: HasProduct.qty,
        status: HasProduct.status,
        returnStatus: HasProduct.return_status,
        refunded: HasProduct.cashback_refunded,
        awb: HasProduct.awb,
        shipment: HasProduct.shipment_id,
        giftVoucherId: HasProduct.gift_voucher_id,
        hash: sql<string>`${sql.raw(checkoutLineHashSql)}`,
      })
      .from(HasProduct)
      .where(eq(HasProduct.order, BigInt(orderId)))
      .orderBy(asc(HasProduct.id))
      .limit(1001)
      .for('update');
    if (
      !lines.length ||
      lines.length > 1000 ||
      lines.some(
        (line) =>
          line.status !== 'DELIVERED' ||
          line.returnStatus !== 0 ||
          line.refunded !== 0 ||
          line.awb !== '' ||
          (line.shipment !== null && line.shipment !== '') ||
          line.giftVoucherId !== 0,
      )
    )
      throw refused('PAYMENT_REVERSAL_LINES_CHANGED');
    const authority = await tx
      .select()
      .from(paymentReversalLineAuthority)
      .where(eq(paymentReversalLineAuthority.orderId, BigInt(orderId)))
      .orderBy(asc(paymentReversalLineAuthority.id))
      .limit(1001)
      .for('update');
    if (
      authority.length !== lines.length ||
      authority.some(
        (line, index) =>
          line.id !== lines[index]?.id ||
          line.shipped !== 0 ||
          line.outForDelivery !== 0 ||
          line.delivered !== 0 ||
          line.cancelledReturn !== 0 ||
          (line.returnAwb !== null && line.returnAwb !== '') ||
          (line.returnCourierId !== null && line.returnCourierId !== 0),
      )
    )
      throw refused('PAYMENT_REVERSAL_FULFILMENT_REVIEW_REQUIRED');
    const [inflightReturn] = await tx
      .select({ id: returnOperations.id })
      .from(returnOperations)
      .where(
        inArray(
          returnOperations.lineId,
          lines.map((line) => String(line.id)),
        ),
      )
      .limit(1)
      .for('update');
    const audits = await tx
      .select({ refunded: cashRefundAudit.refunded, isRefunded: cashRefundAudit.isRefunded })
      .from(cashRefundAudit)
      .where(eq(cashRefundAudit.orderId, BigInt(orderId)))
      .limit(1001)
      .for('update');
    if (
      inflightReturn ||
      audits.length > 1000 ||
      audits.some((audit) => (audit.isRefunded ?? 0) !== 0 || audit.refunded !== 0)
    )
      throw refused('PAYMENT_REVERSAL_RETURN_REVIEW_REQUIRED');
    const [issued] = await tx
      .select({ id: GiftVoucher.id })
      .from(GiftVoucher)
      .where(eq(GiftVoucher.order_id, BigInt(orderId)))
      .limit(1);
    if (issued) throw refused('PAYMENT_REVERSAL_ISSUED_VALUE_REVIEW_REQUIRED');
    // An engagement/inventory delivery already claimed outside this transaction cannot be recalled.
    const effects = await tx
      .select({ id: paymentOutbox.id, kind: paymentOutbox.kind, status: paymentOutbox.status })
      .from(paymentOutbox)
      .where(eq(paymentOutbox.orderId, orderId))
      .limit(1001)
      .for('update');
    if (
      effects.length > 1000 ||
      effects.some((effect) => !['pending', 'delivered', 'superseded'].includes(effect.status))
    )
      throw refused('PAYMENT_REVERSAL_DELIVERY_REVIEW_REQUIRED');
    for (const kind of ['order-kinesis', 'order-engagement'])
      if (
        !effects.some(
          (effect) =>
            effect.kind === kind &&
            (effect.status === 'delivered' ||
              (effect.status === 'pending' && effect.id === `${original.id}:${kind}`)),
        )
      )
        throw refused('PAYMENT_REVERSAL_DELIVERY_REVIEW_REQUIRED');
    const manifest = lines.map((line) => ({
        id: String(line.id),
        productId: String(line.productId),
        quantity: String(line.quantity),
        inputHash: line.hash,
      })),
      snapshotHash = operationHash(
        'payment-correction.snapshot.v1',
        {
          orderId,
          storeId,
          counterId: String(order.counterId),
          headerHash: order.headerHash,
          originalPaymentHash: originalPaymentHash(original, options.hashSecret),
          lines: manifest,
        },
        options.hashSecret,
      );
    return { original, lines: manifest, snapshotHash };
  }
  return {
    async context(
      user: Principal,
      storeId: string,
      orderId: string,
    ): Promise<PaymentReversalContext> {
      return transact(async (tx) => {
        const order = await scope(tx, user, storeId, orderId),
          [prior] = await tx
            .select()
            .from(paymentReversals)
            .where(
              and(eq(paymentReversals.orderId, orderId), eq(paymentReversals.storeId, storeId)),
            )
            .orderBy(desc(paymentReversals.recordedAt), desc(paymentReversals.id))
            .limit(1),
          latest = prior ? verifiedReversal(prior, options.hashSecret) : null,
          base = { orderId, storeId, counterId: String(order.counterId), latest };
        try {
          const value = await evaluate(tx, storeId, orderId, order);
          return {
            ...base,
            eligible: true,
            blocker: null,
            snapshotHash: value.snapshotHash,
            originalPaymentId: value.original.id,
            returnedCash: amount(minorUnits(value.original.cashAmount)),
          };
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          return {
            ...base,
            eligible: false,
            blocker: error.code,
            snapshotHash: null,
            originalPaymentId: null,
            returnedCash: null,
          };
        }
      });
    },
    async get(user: Principal, storeId: string, orderId: string, id: string) {
      return transact(async (tx) => {
        await scope(tx, user, storeId, orderId);
        const [row] = await tx
          .select()
          .from(paymentReversals)
          .where(
            and(
              eq(paymentReversals.id, id),
              eq(paymentReversals.storeId, storeId),
              eq(paymentReversals.orderId, orderId),
            ),
          )
          .limit(1);
        if (!row)
          throw new AppError(
            404,
            'PAYMENT_REVERSAL_NOT_FOUND',
            'The original payment correction was not found.',
          );
        return verifiedReversal(row, options.hashSecret);
      });
    },
    async create(user: Principal, storeId: string, orderId: string, raw: PaymentReversalInput) {
      const input = paymentReversalInputSchema.parse(raw);
      return transact(async (tx) => {
        const order = await scope(tx, user, storeId, orderId),
          hash = operationHash(
            'payment-correction.create.v1',
            { userId: user.id, storeId, orderId, input },
            options.hashSecret,
          ),
          [prior] = await tx
            .select()
            .from(paymentReversals)
            .where(eq(paymentReversals.id, input.operationId))
            .limit(1)
            .for('update');
        if (prior) {
          if (
            prior.requestHash !== hash ||
            prior.operatorId !== user.id ||
            prior.storeId !== storeId ||
            prior.orderId !== orderId
          )
            throw refused('IDEMPOTENCY_CONFLICT');
          return verifiedReversal(prior, options.hashSecret);
        }
        const [used] = await tx
          .select({ id: paymentReversals.id })
          .from(paymentReversals)
          .where(eq(paymentReversals.cashReturnReceiptId, input.cashReturnReceiptId))
          .limit(1);
        if (used) throw refused('CASH_RETURN_RECEIPT_ALREADY_USED');
        const evidence = await evaluate(tx, storeId, orderId, order);
        if (
          input.snapshotHash !== evidence.snapshotHash ||
          input.originalPaymentId !== evidence.original.id ||
          input.counterId !== String(order.counterId) ||
          minorUnits(input.returnedCash) !== minorUnits(evidence.original.cashAmount)
        )
          throw refused('PAYMENT_REVERSAL_STATE_CHANGED');
        const timestamp = now(),
          original = evidence.original,
          receipt = paymentReversalReceiptSchema.parse({
            id: input.operationId,
            contract: paymentReversalContract,
            status: 'recorded',
            orderId,
            storeId,
            counterId: String(order.counterId),
            operatorId: user.id,
            originalPaymentId: original.id,
            originalPaymentHash: originalPaymentHash(original, options.hashSecret),
            transactionId: original.transactionId,
            originalCash: original.cashAmount,
            originalCashReceived: original.cashReceived,
            originalFundingAt: original.updatedAt,
            orderDate: order.createdAt.slice(0, 10),
            returnedCash: amount(minorUnits(input.returnedCash)),
            cashReturnReceiptId: input.cashReturnReceiptId,
            reason: input.reason,
            recordedAt: timestamp,
            businessDate: timestamp.slice(0, 10),
            headerHash: order.headerHash,
            lines: evidence.lines,
            stockChanged: false,
            benefitsChanged: false,
            providerRefunded: false,
            goodsRetainedAtCounter: true,
          }),
          managed = await managedCorrectionOrder(tx, orderId, options.hashSecret);
        if (!managed) {
          const fields = {
            orderId,
            storeId,
            counterId: receipt.counterId,
            orderDate: receipt.orderDate,
            firstPaymentId: original.id,
          };
          await tx
            .insert(paymentCorrectionOrders)
            .values({ ...fields, inputHash: managedOrderHash(fields, options.hashSecret) });
          await appendCorrectionCash(
            tx,
            {
              id: `${original.id}:in`,
              orderId,
              storeId,
              counterId: receipt.counterId,
              operatorId: original.operatorId,
              direction: 'in',
              amount: original.cashAmount,
              businessDate: original.updatedAt.slice(0, 10),
              sourceId: original.id,
              recordedAt: original.updatedAt,
            },
            options.hashSecret,
          );
        }
        await tx.insert(paymentReversals).values({
          id: receipt.id,
          orderId,
          storeId,
          counterId: receipt.counterId,
          operatorId: user.id,
          originalPaymentId: original.id,
          cashReturnReceiptId: input.cashReturnReceiptId,
          requestHash: hash,
          receiptHash: operationHash('payment-correction.receipt.v1', receipt, options.hashSecret),
          receipt,
          requestId: currentRequestTrace()?.requestId ?? null,
          recordedAt: timestamp,
        });
        await appendCorrectionCash(
          tx,
          {
            id: `${receipt.id}:out`,
            orderId,
            storeId,
            counterId: receipt.counterId,
            operatorId: user.id,
            direction: 'out',
            amount: receipt.returnedCash,
            businessDate: receipt.businessDate,
            sourceId: receipt.id,
            recordedAt: timestamp,
          },
          options.hashSecret,
        );
        await tx
          .update(Order)
          .set({ payment_statuses: 1n, order_statuses: 1n })
          .where(eq(Order.id, BigInt(orderId)));
        await tx
          .update(OrderStore)
          .set({
            is_manually_paid: false,
            transaction_id: '',
            message: 'Payment correction recorded',
            offline_payment: '0.00',
            offline_payment_recieved: '0.00',
            online_payment: '0.00',
            online_other_payment: '0.00',
            district_transaction_id: '',
            credit_pincode_id: '',
          })
          .where(eq(OrderStore.id, order.mappingId));
        await tx
          .update(HasProduct)
          .set({ status: 'PLACED' })
          .where(eq(HasProduct.order, BigInt(orderId)));
        // Pending notifications are superseded, not deleted; claimed/uncertain ones were refused above.
        await tx
          .update(paymentOutbox)
          .set({ status: 'superseded' })
          .where(
            and(
              eq(paymentOutbox.orderId, orderId),
              eq(paymentOutbox.status, 'pending'),
              inArray(paymentOutbox.kind, ['order-kinesis', 'order-engagement']),
            ),
          );
        await tx.insert(Comments).values({
          order_id: BigInt(orderId),
          status_id: 1n,
          comment: 'Store Order: recorded cash payment corrected; original history retained.',
          notify: 0,
          user_id: BigInt(user.id),
          package_details: '',
          created_at: timestamp,
          updated_at: timestamp,
          has_product_id: 0n,
          prod_id: 0n,
        });
        await tx.insert(PosTransactionLog).values({
          order_id: BigInt(orderId),
          store_id: BigInt(storeId),
          order_status: 1n,
          payment_status: 1n,
          user_id: 0n,
          pos_user_id: BigInt(user.id),
          pay_dict: JSON.stringify({
            event: 'payment-correction',
            correction_id: receipt.id,
            cash_returned: receipt.returnedCash,
          }),
          comment:
            'Counter cash returned; original payment retained; no provider refund or stock/benefit reversal.',
          created_at: timestamp,
          updated_at: timestamp,
        });
        await staleCorrectionClose(
          tx,
          storeId,
          [receipt.orderDate, receipt.originalFundingAt.slice(0, 10), receipt.businessDate],
          receipt.id,
          timestamp,
        );
        // This transaction never touches stock, wallet, voucher, membership or the original payment JSON.
        await assertCheckoutProjection(tx, { orderId, storeId, counterId: receipt.counterId });
        const [originalRow] = await tx
          .select({ state: paymentAttempts.state })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, original.id));
        if (
          !originalRow ||
          originalPaymentHash(originalRow.state, options.hashSecret) !== receipt.originalPaymentHash
        )
          throw refused('PAYMENT_REVERSAL_ORIGINAL_CHANGED');
        return receipt;
      });
    },
  };
}
