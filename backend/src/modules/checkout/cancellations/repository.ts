import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  HasProduct,
  Order,
  OrderStatus,
  OrderStore,
  PosTransactionLog,
  Product,
  ProductStore,
  Store,
  StoreDayClose,
} from '../../../db/legacy-schema.js';
import { aggregateStock } from '../../../db/stock-projection/schema.js';
import { requireStore, type Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { minorUnits } from '../../../domain/money.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { enqueueInventorySynchronization } from '../../administration/inventory.js';
import { retryTransaction } from '../../../db/retry.js';
import type { StockProcedure } from '../../administration/stock-procedure.js';
import { operationHash } from '../crypto.js';
import { offlineCashOrderLinks, offlineCashReceipts } from '../offline-cash/schema.js';
import { cashRefundAudit } from '../offline-cash/source-ledger.js';
import { readOrderPaymentEvidence } from '../payments/repository.js';
import {
  assertCheckoutProjection,
  assertCheckoutProjectionReady,
  checkoutHeaderHashSql,
  type CheckoutProjectionConfiguration,
} from '../projection.js';
import {
  assertRefundAllocationReady,
  type RefundAllocationConfiguration,
} from '../refund-allocation.js';
import {
  cancellationReceiptSchema,
  pendingCancellationContract,
  type CancellationInput,
  type CancellationReceipt,
} from './contracts.js';
import { applyCancellationBenefits, lockCancellationBenefits } from './benefits.js';
import type { CancellationBenefitProfile } from './benefit-contracts.js';
import type { PendingCancellationOptions } from './options.js';
import { pendingOrderCancellations } from './schema.js';

export interface PendingCancellationRepositoryOptions extends PendingCancellationOptions {
  hashSecret: string;
  /** Approved restoration policy, selected only with independently verified writer contracts. */
  benefitProfile?: CancellationBenefitProfile;
  projection: CheckoutProjectionConfiguration & RefundAllocationConfiguration;
  stockProcedure?: StockProcedure;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string | undefined,
    tx: AdministrationTransaction,
  ) => Promise<void>;
}
const refused = (
  code: string,
  message = 'Review the original order and payment evidence before cancelling this order.',
) => new AppError(409, code, message);
export function pendingCancellationRepository(
  db: Databases,
  config: Config,
  options: PendingCancellationRepositoryOptions,
) {
  const checkIns = checkInService(db, config),
    checkIn =
      options.assertCheckIn ??
      ((userId, storeId, counterId, tx) => checkIns.assertCheckIn(userId, storeId, counterId, tx));
  const now = () =>
    Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const transact = <T>(work: (tx: AdministrationTransaction) => Promise<T>) =>
    retryTransaction(() => db.get('writer').transaction(work));
  async function scope(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
  ) {
    requireStore(user, storeId);
    await checkIn(user.id, storeId, undefined, tx);
    await assertCurrentStoreAccess(tx, user.id, storeId);
    const [store] = await tx
      .select({ id: Store.id })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .for('update');
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store was not found.');
    const rows = await tx
      .select({
        id: Order.id,
        method: Order.payment_methods,
        paymentStatus: Order.payment_statuses,
        status: Order.order_statuses,
        createdAt: Order.created_at,
        customerId: Order.user,
        voucherId: Order.voucher_used,
        cashback: sql<number>`CAST(${Order.cashback_used} AS CHAR)`.mapWith(Number),
        money: sql<number>`CAST(${Order.tss_money_used} AS CHAR)`.mapWith(Number),
        points: sql<number>`CAST(${Order.tss_points_used} AS CHAR)`.mapWith(Number),
        voucherAmount: sql<number | null>`CAST(${Order.voucher_amt_used} AS CHAR)`.mapWith(Number),
        headerHash: sql<string>`${sql.raw(checkoutHeaderHashSql)}`,
        mappingId: OrderStore.id,
        counterId: OrderStore.counter,
        manuallyPaid: OrderStore.is_manually_paid,
        cash: OrderStore.offline_payment,
        received: OrderStore.offline_payment_recieved,
        online: OrderStore.online_payment,
        other: OrderStore.online_other_payment,
      })
      .from(OrderStore)
      .innerJoin(Order, eq(Order.id, OrderStore.order))
      .where(and(eq(OrderStore.store, BigInt(storeId)), eq(Order.id, BigInt(orderId))))
      .limit(2)
      .for('update');
    if (rows.length !== 1)
      throw new AppError(404, 'ORDER_NOT_FOUND', 'A unique order was not found in this store.');
    const order = rows[0]!;
    await checkIn(user.id, storeId, String(order.counterId), tx);
    return order;
  }
  function receipt(row: typeof pendingOrderCancellations.$inferSelect) {
    const validated = cancellationReceiptSchema.safeParse(row.receipt);
    if (!validated.success)
      throw new AppError(
        503,
        'CANCELLATION_RECEIPT_INVALID',
        'The original cancellation evidence needs reconciliation.',
      );
    const parsed = validated.data;
    if (
      row.id !== parsed.id ||
      row.orderId !== parsed.orderId ||
      row.storeId !== parsed.storeId ||
      row.counterId !== parsed.counterId ||
      row.operatorId !== parsed.operatorId ||
      row.receiptHash !==
        operationHash('pending-order-cancellation.receipt', parsed, options.hashSecret)
    )
      throw new AppError(
        503,
        'CANCELLATION_RECEIPT_INVALID',
        'The original cancellation evidence needs reconciliation.',
      );
    return parsed;
  }
  async function prior(tx: AdministrationTransaction, storeId: string, orderId: string) {
    const [record] = await tx
      .select()
      .from(pendingOrderCancellations)
      .where(
        and(
          eq(pendingOrderCancellations.orderId, orderId),
          eq(pendingOrderCancellations.storeId, storeId),
        ),
      )
      .limit(1)
      .for('update');
    return record;
  }
  async function evaluate(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    order: Awaited<ReturnType<typeof scope>>,
  ) {
    // Pinned API-v2 OrderController.py:5482 marks this SKU non-cancellable
    // for every status. Enforce that intent before projection/benefit reads:
    // an Order holder must not wait for the screening counter's customer lock.
    // Existing immutable receipts bypass evaluate() and remain readable.
    const [screening] = await tx
      .select({ id: HasProduct.id })
      .from(HasProduct)
      .where(and(eq(HasProduct.order, BigInt(orderId)), eq(HasProduct.product, 390238n)))
      .limit(1)
      .for('share');
    if (screening)
      throw refused('CANCELLATION_SCREENING_UNSUPPORTED', 'Screening tickets cannot be cancelled.');
    if (
      options.contract !== pendingCancellationContract ||
      !options.membershipProductIds ||
      options.hashSecret.length < 32
    )
      throw new AppError(
        503,
        'PENDING_CANCELLATION_CONTRACT_UNVERIFIED',
        'Verify the source cancellation and membership configuration before cancelling an order.',
      );
    if (!options.stockProcedure)
      throw new AppError(
        503,
        'PENDING_CANCELLATION_STOCK_UNVERIFIED',
        'A transaction-scoped stock projection is required before cancellation.',
      );
    if (
      order.method !== 14n ||
      order.paymentStatus !== 1n ||
      order.status !== 1n ||
      order.manuallyPaid ||
      [order.cash, order.received, order.online, order.other].some(
        (value) => minorUnits(String(value)) !== 0n,
      )
    )
      throw refused('ORDER_NOT_CANCELLABLE');
    for (const table of [offlineCashOrderLinks, offlineCashReceipts]) {
      const [cash] = await tx
        .select({ id: table.orderId })
        .from(table)
        .where(eq(table.orderId, orderId))
        .limit(1);
      if (cash) throw refused('ORDER_ALREADY_SETTLED_OFFLINE');
    }
    const payment = await readOrderPaymentEvidence(tx, orderId, options.hashSecret);
    if (
      payment.completed ||
      payment.ambiguous ||
      payment.candidates.length ||
      payment.attempts.some(
        (attempt) =>
          !['failed', 'cancelled'].includes(attempt.status) ||
          minorUnits(attempt.cashAmount) > 0n ||
          minorUnits(attempt.cashReceived) > 0n,
      )
    )
      throw refused(
        'CANCELLATION_PAYMENT_UNRESOLVED',
        'Confirm every original terminal payment and any cash already received before cancelling this order.',
      );
    assertCheckoutProjectionReady(options.projection);
    assertRefundAllocationReady(options.projection);
    await assertCheckoutProjection(tx, { orderId, storeId, counterId: String(order.counterId) });
    const lines = await tx
      .select({
        id: HasProduct.id,
        productId: HasProduct.product,
        quantity: HasProduct.qty,
        status: HasProduct.status,
        refunded: HasProduct.cashback_refunded,
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
          line.status !== 'PLACED' ||
          line.quantity < 1n ||
          line.quantity > 999n ||
          (line.refunded ?? 0) !== 0,
      )
    )
      throw refused('CANCELLATION_LINES_CHANGED');
    const membership = lines.some((line) =>
      options.membershipProductIds!.includes(String(line.productId)),
    );
    if (membership && !options.benefitProfile)
      throw refused('CANCELLATION_MEMBERSHIP_RESTORATION_UNVERIFIED');
    const audits = await tx
      .select({
        id: cashRefundAudit.id,
        lineId: cashRefundAudit.lineId,
        productId: cashRefundAudit.productId,
        money: sql<number>`CAST(${cashRefundAudit.money} AS CHAR)`.mapWith(Number),
        points: sql<number>`CAST(${cashRefundAudit.points} AS CHAR)`.mapWith(Number),
        voucher: sql<number>`CAST(${cashRefundAudit.voucher} AS CHAR)`.mapWith(Number),
        refundable: cashRefundAudit.refundable,
        refunded: cashRefundAudit.refunded,
        isRefunded: cashRefundAudit.isRefunded,
      })
      .from(cashRefundAudit)
      .where(eq(cashRefundAudit.orderId, BigInt(orderId)))
      .orderBy(asc(cashRefundAudit.id))
      .limit(1001)
      .for('update');
    const auditByLine = new Map(audits.map((audit) => [String(audit.lineId), audit]));
    if (
      audits.length !== lines.length ||
      auditByLine.size !== lines.length ||
      lines.some((line) => {
        const audit = auditByLine.get(String(line.id));
        return (
          !audit ||
          audit.productId !== line.productId ||
          (audit.isRefunded ?? 0) !== 0 ||
          audit.refunded !== 0
        );
      })
    )
      throw refused('CANCELLATION_REFUND_EVIDENCE_INVALID');
    if (!Number.isFinite(order.cashback) || order.cashback !== 0)
      throw refused('CANCELLATION_CASHBACK_UNSUPPORTED');
    const hasBenefits =
      [order.money, order.points, order.voucherAmount ?? 0].some((value) => value !== 0) ||
      audits.some((audit) => audit.money !== 0 || audit.points !== 0 || audit.voucher !== 0);
    if (hasBenefits && !options.benefitProfile)
      throw refused(
        'CANCELLATION_BENEFIT_RESTORATION_UNVERIFIED',
        'This order includes spent benefits. Its source-derived restoration contract must be verified before cancellation.',
      );
    const benefits =
      hasBenefits || membership
        ? await lockCancellationBenefits(
            tx,
            {
              orderId,
              customerId: String(order.customerId),
              voucherId: String(order.voucherId ?? 0n),
              headerHash: order.headerHash,
              money: order.money,
              points: order.points,
              voucher: order.voucherAmount ?? 0,
              lines: lines.map((line) => {
                const audit = auditByLine.get(String(line.id))!;
                return {
                  lineId: String(line.id),
                  productId: String(line.productId),
                  money: audit.money,
                  points: audit.points,
                  voucher: audit.voucher,
                };
              }),
              membership,
              timestamp: now(),
            },
            options.benefitProfile!,
            options.hashSecret,
          )
        : null;
    const snapshotHash = operationHash(
      'pending-order-cancellation.snapshot',
      {
        storeId,
        orderId,
        counterId: String(order.counterId),
        headerHash: order.headerHash,
        lines: lines.map((line) => ({
          id: String(line.id),
          productId: String(line.productId),
          quantity: String(line.quantity),
        })),
        audits: audits.map((audit) => ({
          id: String(audit.id),
          lineId: String(audit.lineId),
          refundable: audit.refundable,
          money: audit.money,
          points: audit.points,
          voucher: audit.voucher,
        })),
        ...(benefits ? { benefitFingerprint: benefits.fingerprint } : {}),
        contract: options.contract,
        membershipProductIds: [...options.membershipProductIds].sort(),
      },
      options.hashSecret,
    );
    return { lines, audits, snapshotHash, benefits };
  }
  return {
    async context(user: Principal, storeId: string, orderId: string) {
      return transact(async (tx) => {
        const order = await scope(tx, user, storeId, orderId),
          saved = await prior(tx, storeId, orderId);
        if (saved)
          return {
            orderId,
            storeId,
            counterId: String(order.counterId),
            eligible: false,
            snapshotHash: null,
            blocker: null,
            receipt: receipt(saved),
          };
        try {
          const result = await evaluate(tx, user, storeId, orderId, order);
          return {
            orderId,
            storeId,
            counterId: String(order.counterId),
            eligible: true,
            snapshotHash: result.snapshotHash,
            blocker: null,
            receipt: null,
            ...(result.benefits ? { benefits: result.benefits.summary } : {}),
          };
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          return {
            orderId,
            storeId,
            counterId: String(order.counterId),
            eligible: false,
            snapshotHash: null,
            blocker: error.code,
            receipt: null,
          };
        }
      });
    },
    async get(user: Principal, storeId: string, orderId: string, id: string) {
      return transact(async (tx) => {
        await scope(tx, user, storeId, orderId);
        const row = await prior(tx, storeId, orderId);
        if (!row || row.id !== id)
          throw new AppError(
            404,
            'CANCELLATION_NOT_FOUND',
            'The original cancellation was not found.',
          );
        return receipt(row);
      });
    },
    async create(user: Principal, storeId: string, orderId: string, input: CancellationInput) {
      return transact(async (tx) => {
        const order = await scope(tx, user, storeId, orderId),
          saved = await prior(tx, storeId, orderId),
          requestHash = operationHash(
            'pending-order-cancellation.create',
            { operatorId: user.id, storeId, orderId, input },
            options.hashSecret,
          );
        if (saved) {
          if (
            saved.id !== input.operationId ||
            saved.operatorId !== user.id ||
            saved.requestHash !== requestHash
          )
            throw refused('ORDER_ALREADY_CANCELLED');
          return receipt(saved);
        }
        const [used] = await tx
          .select({ id: pendingOrderCancellations.id })
          .from(pendingOrderCancellations)
          .where(eq(pendingOrderCancellations.id, input.operationId))
          .limit(1);
        if (used) throw refused('IDEMPOTENCY_CONFLICT');
        const evidence = await evaluate(tx, user, storeId, orderId, order);
        if (input.snapshotHash !== evidence.snapshotHash)
          throw refused('CANCELLATION_STATE_CHANGED');
        const [cancelled] = await tx
          .select({ name: OrderStatus.order_status })
          .from(OrderStatus)
          .where(eq(OrderStatus.id, 4n))
          .limit(1);
        if (!cancelled?.name)
          throw new AppError(
            503,
            'ORDER_STATUS_UNAVAILABLE',
            'The cancelled order status is unavailable.',
          );
        const grouped = new Map<string, number>();
        for (const line of evidence.lines)
          grouped.set(
            String(line.productId),
            (grouped.get(String(line.productId)) ?? 0) + Number(line.quantity),
          );
        const productIds = [...grouped.keys()].sort((a, b) =>
            BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0,
          ),
          restoredProducts: CancellationReceipt['restoredProducts'] = [];
        for (const productId of productIds) {
          const [product] = await tx
            .select({ id: Product.id })
            .from(Product)
            .where(eq(Product.id, BigInt(productId)))
            .for('update');
          const [aggregate] = await tx
            .select({ id: aggregateStock.productId })
            .from(aggregateStock)
            .where(eq(aggregateStock.productId, BigInt(productId)))
            .for('update');
          const stocks = await tx
            .select({ id: ProductStore.id, stock: ProductStore.stock })
            .from(ProductStore)
            .where(
              and(
                eq(ProductStore.store, BigInt(storeId)),
                eq(ProductStore.product, BigInt(productId)),
              ),
            )
            .limit(2)
            .for('update');
          if (
            !product ||
            !aggregate ||
            stocks.length !== 1 ||
            !Number.isInteger(stocks[0]!.stock) ||
            stocks[0]!.stock < 0
          )
            throw refused('CANCELLATION_STOCK_UNAVAILABLE');
          const current = stocks[0]!,
            quantity = grouped.get(productId)!,
            after = current.stock + quantity;
          if (after > 2147483647) throw refused('CANCELLATION_STOCK_OVERFLOW');
          await options.stockProcedure!(tx, {
            productId,
            storeId,
            stock: after,
            operatorId: user.id,
            comment: `Product inventory added from admin panel on order cancel, [Order ID:${orderId}]`,
          });
          const [verified] = await tx
            .select({ stock: ProductStore.stock })
            .from(ProductStore)
            .where(eq(ProductStore.id, current.id))
            .for('update');
          if (verified?.stock !== after) throw refused('CANCELLATION_STOCK_UNCONFIRMED');
          restoredProducts.push({ productId, quantity, before: current.stock, after });
        }
        const date = now();
        if (evidence.benefits) await applyCancellationBenefits(tx, evidence.benefits);
        await tx
          .update(Order)
          .set({ payment_statuses: 2n, order_statuses: 4n })
          .where(eq(Order.id, BigInt(orderId)));
        await tx
          .update(HasProduct)
          .set({ status: cancelled.name, cashback_refunded: 1 })
          .where(eq(HasProduct.order, BigInt(orderId)));
        for (const audit of evidence.audits)
          await tx
            .update(cashRefundAudit)
            .set({
              isRefunded: 1,
              comment: `Pay Amount Reverted For Product ${audit.productId} in Order ${orderId} Cancellation`,
            })
            .where(eq(cashRefundAudit.id, audit.id));
        await tx.insert(PosTransactionLog).values({
          order_id: BigInt(orderId),
          store_id: BigInt(storeId),
          order_status: 4n,
          payment_status: 2n,
          user_id: 0n,
          pos_user_id: BigInt(user.id),
          pay_dict: '{}',
          comment: 'Order Cancelled : No Transaction Made',
          created_at: date,
          updated_at: date,
        });
        const [close] = await tx
          .select()
          .from(StoreDayClose)
          .where(
            and(
              eq(StoreDayClose.store_id, Number(storeId)),
              eq(StoreDayClose.close_date, order.createdAt.slice(0, 10)),
            ),
          )
          .orderBy(desc(StoreDayClose.version))
          .limit(1)
          .for('update');
        const closeImpact =
          close && ['CLOSED', 'STALE'].includes(close.status)
            ? { id: String(close.id), priorStatus: close.status, priorReason: close.stale_reason }
            : null;
        if (closeImpact)
          await tx
            .update(StoreDayClose)
            .set({
              status: 'STALE',
              stale_at: date,
              stale_reason: 'ORDER_CANCELLED',
              stale_trigger_ref: input.operationId,
              updated_at: date,
            })
            .where(eq(StoreDayClose.id, close!.id));
        await enqueueInventorySynchronization(tx, {
          id: input.operationId,
          storeId,
          productIds,
          operatorId: user.id,
          requestId: currentRequestTrace()?.requestId,
          reason: 'order-cancel',
        });
        const result = cancellationReceiptSchema.parse({
          id: input.operationId,
          orderId,
          storeId,
          counterId: String(order.counterId),
          operatorId: user.id,
          status: 'cancelled',
          cashRefunded: '0.00',
          cancelledAt: date,
          snapshotHash: input.snapshotHash,
          restoredProducts,
          lineIds: evidence.lines.map((line) => String(line.id)),
          closeImpact,
          ...(evidence.benefits ? { benefits: evidence.benefits.summary } : {}),
        });
        await tx.insert(pendingOrderCancellations).values({
          id: result.id,
          orderId,
          storeId,
          counterId: result.counterId,
          operatorId: user.id,
          requestHash,
          receipt: result,
          receiptHash: operationHash(
            'pending-order-cancellation.receipt',
            result,
            options.hashSecret,
          ),
          requestId: currentRequestTrace()?.requestId || null,
          createdAt: date,
        });
        return result;
      });
    },
  };
}
