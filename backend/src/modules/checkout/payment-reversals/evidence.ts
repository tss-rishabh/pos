import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { StoreDayClose, GiftVoucher } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { amount, minorUnits } from '../../../domain/money.js';
import { operationHash } from '../crypto.js';
import { storedPaymentAttemptSchema, type PaymentAttempt } from '../payments/contracts.js';
import { paymentAttempts } from '../payments/schema.js';
import { paymentReversalReceiptSchema, type PaymentReversalReceipt } from './contracts.js';
import {
  paymentCorrectionCash,
  paymentCorrectionCloseImpacts,
  paymentCorrectionOrders,
  paymentReversals,
} from './schema.js';
import { assertNoPendingCashReturnForOrders } from './intent-guards.js';
import { advanceFinancialControl, instantSql } from './intent-evidence.js';

type Transaction = AdministrationTransaction;
export interface PaymentCorrectionPort {
  effective(
    tx: Transaction,
    attempts: readonly PaymentAttempt[],
    exceptIntentId?: string,
    exceptClaimId?: string,
  ): Promise<PaymentAttempt[]>;
  restrictedToCash(tx: Transaction, orderId: string): Promise<boolean>;
  assertStart(tx: Transaction, orderId: string, channel: PaymentAttempt['channel']): Promise<void>;
  recordSettlement(tx: Transaction, attempt: PaymentAttempt, timestamp: string): Promise<boolean>;
}
export const correctionReview = () =>
  new AppError(
    409,
    'PAYMENT_CORRECTION_EVIDENCE_INVALID',
    'The original payment correction needs reconciliation. Do not collect another payment.',
  );
export const originalPaymentHash = (attempt: PaymentAttempt, secret: string) =>
  operationHash('payment-correction.original-payment.v1', attempt, secret);
export function verifiedReversal(
  row: typeof paymentReversals.$inferSelect,
  secret: string,
): PaymentReversalReceipt {
  const parsed = paymentReversalReceiptSchema.safeParse(row.receipt);
  if (!parsed.success) throw correctionReview();
  const value = parsed.data;
  if (
    row.id !== value.id ||
    row.orderId !== value.orderId ||
    row.storeId !== value.storeId ||
    row.counterId !== value.counterId ||
    row.operatorId !== value.operatorId ||
    row.originalPaymentId !== value.originalPaymentId ||
    row.cashReturnReceiptId !== value.cashReturnReceiptId ||
    row.recordedAt !== value.recordedAt ||
    row.receiptHash !== operationHash('payment-correction.receipt.v1', value, secret) ||
    minorUnits(value.originalCash) !== minorUnits(value.returnedCash) ||
    minorUnits(value.originalCash) <= 0n ||
    minorUnits(value.originalCashReceived) < minorUnits(value.originalCash) ||
    value.businessDate !== (value.cashReturn?.businessDate ?? value.recordedAt.slice(0, 10)) ||
    (value.cashReturn &&
      (value.cashReturn.businessDate !== value.cashReturn.returnedAt.slice(0, 10) ||
        !value.recordedInstant ||
        Temporal.Instant.compare(
          Temporal.Instant.from(value.cashReturn.returnedInstant),
          Temporal.Instant.from(value.recordedInstant),
        ) > 0)) ||
    new Set(value.lines.map((line) => line.id)).size !== value.lines.length
  )
    throw correctionReview();
  return value;
}
export function managedOrderHash(
  row: Omit<typeof paymentCorrectionOrders.$inferSelect, 'inputHash'>,
  secret: string,
) {
  return operationHash('payment-correction.order.v1', row, secret);
}
export async function managedCorrectionOrder(
  tx: Pick<Transaction, 'select'>,
  orderId: string,
  secret: string,
) {
  const [row] = await tx
    .select()
    .from(paymentCorrectionOrders)
    .where(eq(paymentCorrectionOrders.orderId, orderId))
    .limit(1);
  if (!row) return null;
  const { inputHash, ...fields } = row;
  if (inputHash !== managedOrderHash(fields, secret)) throw correctionReview();
  return row;
}
export function cashMovementHash(
  row: Omit<typeof paymentCorrectionCash.$inferSelect, 'inputHash'>,
  secret: string,
) {
  return operationHash('payment-correction.cash.v1', row, secret);
}
export async function appendCorrectionCash(
  tx: Transaction,
  fields: Omit<typeof paymentCorrectionCash.$inferInsert, 'inputHash'>,
  secret: string,
) {
  const row = { ...fields, amount: amount(minorUnits(fields.amount)) };
  if (
    minorUnits(row.amount) <= 0n ||
    !['in', 'out'].includes(row.direction) ||
    row.businessDate !== row.recordedAt.slice(0, 10)
  )
    throw correctionReview();
  await tx
    .insert(paymentCorrectionCash)
    .values({ ...row, inputHash: cashMovementHash(row, secret) });
}
function assertReversalMoney(
  receipt: PaymentReversalReceipt,
  original: PaymentAttempt,
  managed: typeof paymentCorrectionOrders.$inferSelect,
  rows: readonly (typeof paymentCorrectionCash.$inferSelect)[],
  secret: string,
) {
  const { inputHash: managedHash, ...managedFields } = managed;
  if (managedHash !== managedOrderHash(managedFields, secret)) throw correctionReview();
  if (
    !managed ||
    managed.storeId !== receipt.storeId ||
    managed.counterId !== receipt.counterId ||
    managed.orderDate !== receipt.orderDate ||
    rows.length !== 2
  )
    throw correctionReview();
  for (const row of rows) {
    const { inputHash, ...fields } = row,
      incoming = row.direction === 'in';
    if (
      !['in', 'out'].includes(row.direction) ||
      inputHash !== cashMovementHash(fields, secret) ||
      row.id !== (incoming ? `${original.id}:in` : `${receipt.id}:out`) ||
      row.sourceId !== (incoming ? original.id : receipt.id) ||
      row.storeId !== receipt.storeId ||
      row.counterId !== receipt.counterId ||
      row.orderId !== receipt.orderId ||
      row.operatorId !== (incoming ? original.operatorId : reversalCashActor(receipt)) ||
      row.recordedAt !== (incoming ? receipt.originalFundingAt : reversalCashTime(receipt)) ||
      row.businessDate !== row.recordedAt.slice(0, 10) ||
      minorUnits(row.amount) !== minorUnits(incoming ? receipt.originalCash : receipt.returnedCash)
    )
      throw correctionReview();
  }
}
/** Caller holds Store FOR UPDATE before order/payment locks. Frozen close totals never change. */
export async function staleCorrectionClose(
  tx: Transaction,
  storeId: string,
  dates: readonly string[],
  sourceId: string,
  timestamp: string,
  reason: 'PAYMENT_CORRECTION' | 'CASH_RETURN_PENDING' = 'PAYMENT_CORRECTION',
) {
  for (const date of [...new Set(dates)].sort()) {
    const [close] = await tx
      .select({
        id: StoreDayClose.id,
        version: StoreDayClose.version,
        status: StoreDayClose.status,
      })
      .from(StoreDayClose)
      .where(and(eq(StoreDayClose.store_id, Number(storeId)), eq(StoreDayClose.close_date, date)))
      .orderBy(desc(StoreDayClose.version))
      .limit(1)
      .for('update');
    if (!close || !['CLOSED', 'STALE'].includes(close.status)) continue;
    await tx.insert(paymentCorrectionCloseImpacts).values({
      id: `${sourceId}:${date}`,
      sourceId,
      storeId,
      businessDate: date,
      closeId: String(close.id),
      closeVersion: String(close.version),
      recordedAt: timestamp,
    });
    if (close.status === 'CLOSED')
      await tx
        .update(StoreDayClose)
        .set({
          status: 'STALE',
          stale_at: timestamp,
          stale_reason: reason,
          stale_trigger_ref: sourceId,
          updated_at: timestamp,
        })
        .where(eq(StoreDayClose.id, close.id));
  }
}
/** Original paid JSON remains unchanged. Only a validated immutable compensation changes its effective view. */
export function paymentCorrectionEvidence(secret: string): PaymentCorrectionPort {
  const effective: PaymentCorrectionPort['effective'] = async (
    tx,
    attempts,
    exceptIntentId,
    exceptClaimId,
  ) => {
    if (!attempts.length) return [];
    await assertNoPendingCashReturnForOrders(
      tx,
      attempts.map((value) => value.orderId),
      secret,
      exceptIntentId,
      exceptClaimId,
    );
    if (attempts.length > 100) throw correctionReview();
    const rows = await tx
      .select()
      .from(paymentReversals)
      .where(
        inArray(
          paymentReversals.originalPaymentId,
          attempts.map((value) => value.id),
        ),
      )
      .orderBy(asc(paymentReversals.id))
      .limit(101)
      .for('update');
    if (rows.length > 100) throw correctionReview();
    if (!rows.length) return [...attempts];
    const receipts = rows.map((row) => verifiedReversal(row, secret)),
      index = new Map(receipts.map((value) => [value.originalPaymentId, value])),
      orderIds = [...new Set(receipts.map((value) => value.orderId))],
      cashIds = [
        ...new Set(
          receipts.flatMap((value) => [`${value.originalPaymentId}:in`, `${value.id}:out`]),
        ),
      ];
    // Three bounded, indexed batches regardless of the number of old attempts.
    const managedRows = await tx
      .select()
      .from(paymentCorrectionOrders)
      .where(inArray(paymentCorrectionOrders.orderId, orderIds))
      .orderBy(asc(paymentCorrectionOrders.orderId))
      .for('update');
    const cashRows = await tx
      .select()
      .from(paymentCorrectionCash)
      .where(inArray(paymentCorrectionCash.id, cashIds))
      .orderBy(asc(paymentCorrectionCash.id))
      .for('update');
    const managedIndex = new Map(managedRows.map((value) => [value.orderId, value])),
      cashIndex = new Map(cashRows.map((value) => [value.id, value]));
    return attempts.map((attempt) => {
      const receipt = index.get(attempt.id);
      if (!receipt) return attempt;
      if (
        attempt.status !== 'paid' ||
        attempt.channel !== 'cash' ||
        attempt.orderId !== receipt.orderId ||
        attempt.storeId !== receipt.storeId ||
        attempt.counterId !== receipt.counterId ||
        originalPaymentHash(attempt, secret) !== receipt.originalPaymentHash
      )
        throw correctionReview();
      const managed = managedIndex.get(receipt.orderId),
        incoming = cashIndex.get(`${attempt.id}:in`),
        outgoing = cashIndex.get(`${receipt.id}:out`);
      if (!managed || !incoming || !outgoing) throw correctionReview();
      assertReversalMoney(receipt, attempt, managed, [incoming, outgoing], secret);
      return { ...attempt, status: 'reversed' as const, reversalId: receipt.id };
    });
  };
  return {
    effective,
    async restrictedToCash(tx, orderId) {
      return (await managedCorrectionOrder(tx, orderId, secret)) !== null;
    },
    async assertStart(tx, orderId, channel) {
      await assertNoPendingCashReturnForOrders(tx, [orderId], secret);
      if (channel !== 'cash' && (await managedCorrectionOrder(tx, orderId, secret)))
        throw new AppError(
          409,
          'PAYMENT_CORRECTION_CASH_ONLY',
          'A corrected cash settlement requires a new cash receipt. Other tender corrections need reconciliation.',
        );
    },
    async recordSettlement(tx, attempt, timestamp) {
      const managed = await managedCorrectionOrder(tx, attempt.orderId, secret);
      if (!managed) return false;
      const [issued] = await tx
        .select({ id: GiftVoucher.id })
        .from(GiftVoucher)
        .where(eq(GiftVoucher.order_id, BigInt(attempt.orderId)))
        .limit(1)
        .for('update');
      if (issued)
        throw new AppError(
          409,
          'PAYMENT_REVERSAL_ISSUED_VALUE_REVIEW_REQUIRED',
          'Issued value changed after the cash correction. Reconcile its original funding before taking another payment.',
        );
      const originalRows = await tx
        .select({ state: paymentAttempts.state })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, attempt.orderId))
        .limit(101)
        .for('update');
      await effective(
        tx,
        originalRows.map((row) => storedPaymentAttemptSchema.parse(row.state)),
      );
      if (
        attempt.channel !== 'cash' ||
        minorUnits(attempt.onlineAmount) !== 0n ||
        attempt.storeId !== managed.storeId ||
        attempt.counterId !== managed.counterId
      )
        throw new AppError(
          409,
          'PAYMENT_CORRECTION_CASH_ONLY',
          'A corrected cash settlement requires a new cash receipt. Other tender corrections need reconciliation.',
        );
      await appendCorrectionCash(
        tx,
        {
          id: `${attempt.id}:in`,
          orderId: attempt.orderId,
          storeId: attempt.storeId,
          counterId: attempt.counterId,
          operatorId: attempt.operatorId,
          direction: 'in',
          amount: attempt.cashAmount,
          businessDate: timestamp.slice(0, 10),
          sourceId: attempt.id,
          recordedAt: timestamp,
        },
        secret,
      );
      await staleCorrectionClose(
        tx,
        attempt.storeId,
        [managed.orderDate, timestamp.slice(0, 10)],
        attempt.id,
        timestamp,
      );
      await advanceFinancialControl(
        tx,
        {
          storeId: attempt.storeId,
          id: attempt.id,
          dates: [managed.orderDate, timestamp.slice(0, 10)],
          hash: operationHash(
            'cash-return.repayment.v1',
            { attemptId: attempt.id, amount: attempt.cashAmount, recordedAt: timestamp },
            secret,
          ),
        },
        0,
        secret,
        instantSql(Temporal.Now.instant()),
      );
      return true;
    },
  };
}
export const reversalCashActor = (receipt: PaymentReversalReceipt) =>
  receipt.cashReturn?.returnedBy ?? receipt.operatorId;
export const reversalCashTime = (receipt: PaymentReversalReceipt) =>
  receipt.cashReturn?.returnedAt ?? receipt.recordedAt;
