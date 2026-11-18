import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  Comments,
  GiftVoucher,
  HasProduct,
  Order,
  OrderStatus,
  OrderStore,
  PosMachine,
  PosPaytmMachine,
  PosPaytmTransaction,
  PosTerminalTransaction,
  PosTerminalPaymentModes,
  PosTransactionLog,
  StoreDayClose,
  Store,
} from '../../../db/legacy-schema.js';
import type { Principal } from '../../../domain/access.js';
import { requireStore } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { amount, minorUnits } from '../../../domain/money.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { operationHash } from '../crypto.js';
import {
  storedPaymentAttemptSchema,
  paymentMode,
  terminalPayment,
  type PaymentAttempt,
  type PaymentInput,
  type ProviderDecision,
  type Terminal,
  type LegacyPaymentRecoveryInput,
} from './contracts.js';
import { legacyPaymentRecoveries, paymentAttempts, paymentOutbox } from './schema.js';
import {
  legacyChannel,
  legacyPaymentEvidence,
  legacyReview,
  legacyPaymentSourceHash,
  normalizedLegacyAmounts,
  type LegacyTerminalRecord,
} from './legacy.js';
import { currentRequestTrace } from '../../../observability/context.js';
import {
  assertCheckoutProjection,
  assertCheckoutProjectionReady,
  type CheckoutProjectionConfiguration,
} from '../projection.js';
import {
  assertRefundAllocationReady,
  type RefundAllocationConfiguration,
} from '../refund-allocation.js';
import { offlineCashOrderLinks, offlineCashReceipts } from '../offline-cash/schema.js';
import { recordGiftCardIssuance } from '../gift-card-issuance.js';
import { checkoutSessions } from '../schema.js';
import { checkoutStateSchema } from '../contracts.js';
import { pendingOrderCancellations } from '../cancellations/schema.js';
import type { PaymentCorrectionPort } from '../payment-reversals/evidence.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { retryTransaction } from '../../../db/retry.js';
import { readPaymentProviderFact, retainPaymentProviderFact } from './provider-evidence.js';
import type { PaymentDispatchFrame } from './dispatch-evidence.js';

export function validatePaymentSplit(input: PaymentInput, payable: string) {
  const online = minorUnits(input.onlineAmount),
    cash = minorUnits(input.cashAmount),
    received = minorUnits(input.cashReceived);
  if (online + cash === 0n)
    throw new AppError(
      409,
      'PAYMENT_NOT_REQUIRED',
      'This order requires confirmation of its prepaid settlement.',
    );
  if ([online, cash, received].some((value) => value > 9999999999n))
    throw new AppError(
      422,
      'PAYMENT_AMOUNT_TOO_LARGE',
      'Payment exceeds the supported ledger precision.',
    );
  if (online + cash !== minorUnits(payable))
    throw new AppError(
      422,
      'PAYMENT_TOTAL_MISMATCH',
      'Payment amounts must equal the authoritative order payable.',
    );
  if (received < cash)
    throw new AppError(
      422,
      'INSUFFICIENT_CASH_RECEIVED',
      'Cash received must cover the cash portion.',
    );
  if ((input.channel === 'cash' && online !== 0n) || (input.channel !== 'cash' && online === 0n))
    throw new AppError(
      422,
      'PAYMENT_CHANNEL_MISMATCH',
      'Choose a payment method matching the cash and online portions.',
    );
  if (terminalPayment(input.channel) && !input.machineId)
    throw new AppError(
      422,
      'PAYMENT_MACHINE_REQUIRED',
      'Select an active terminal in this counter.',
    );
  if (['district', 'pincode'].includes(input.channel) && !input.externalReference)
    throw new AppError(
      422,
      'PAYMENT_REFERENCE_REQUIRED',
      'This payment method requires its external transaction reference.',
    );
}
export type PaymentTransaction = AdministrationTransaction;
export interface PaymentRepositoryOptions {
  corrections?: PaymentCorrectionPort;
  clock?: () => Temporal.Instant;
  hashSecret: string;
  projection: CheckoutProjectionConfiguration & RefundAllocationConfiguration;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string | undefined,
    transaction: PaymentTransaction,
  ) => Promise<void>;
}
const channelForMode = (mode: number): PaymentInput['channel'] | undefined =>
  (
    ({
      1: 'pine-card',
      10: 'pine-upi',
      1001: 'other',
      1003: 'paytm-card',
      1004: 'paytm-qr',
      1005: 'district',
      1006: 'pincode',
    }) as const
  )[mode as 1 | 10 | 1001 | 1003 | 1004 | 1005 | 1006];
export async function readOrderPaymentEvidence(
  tx: PaymentTransaction,
  orderId: string,
  hashSecret: string,
) {
  const saved = await tx
    .select({ state: paymentAttempts.state })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, orderId))
    .orderBy(desc(paymentAttempts.createdAt), desc(paymentAttempts.id))
    .limit(101)
    .for('update');
  const attempts = saved.map((row) => storedPaymentAttemptSchema.parse(row.state));
  const records: LegacyTerminalRecord[] = [];
  const common = {
    id: PosTerminalTransaction.id,
    storeId: PosTerminalTransaction.store_id,
    transactionId: PosTerminalTransaction.transaction_id,
    onlineAmount: PosTerminalTransaction.amount,
    cashAmount: PosTerminalTransaction.cash_amount,
    cashReceived: PosTerminalTransaction.cash_recieved,
    paymentMode: PosTerminalTransaction.payment_mode,
    platform: PosTerminalTransaction.platform,
  };
  const pine = await tx
    .select({
      ...common,
      reference: PosTerminalTransaction.plutus_id,
      code: PosTerminalTransaction.store_pos_code,
      imei: PosTerminalTransaction.imei,
    })
    .from(PosTerminalTransaction)
    .where(
      and(
        eq(PosTerminalTransaction.order_id, BigInt(orderId)),
        inArray(PosTerminalTransaction.platform, ['txn_created', 'txn_completed']),
      ),
    )
    .orderBy(asc(PosTerminalTransaction.id))
    .limit(201)
    .for('update');
  for (const row of pine)
    records.push({
      ...row,
      provider: 'pine',
      id: String(row.id),
      storeId: String(row.storeId),
      providerReference: row.reference || null,
      storePosCode: row.code,
      mid: '',
      tid: '',
      onlineAmount: String(row.onlineAmount),
      cashAmount: String(row.cashAmount),
      cashReceived: String(row.cashReceived),
    });
  const paytm = await tx
    .select({
      id: PosPaytmTransaction.id,
      storeId: PosPaytmTransaction.store_id,
      transactionId: PosPaytmTransaction.transaction_id,
      onlineAmount: PosPaytmTransaction.amount,
      cashAmount: PosPaytmTransaction.cash_amount,
      cashReceived: PosPaytmTransaction.cash_recieved,
      paymentMode: PosPaytmTransaction.payment_mode,
      platform: PosPaytmTransaction.platform,
      mid: PosPaytmTransaction.paytm_mid,
      tid: PosPaytmTransaction.paytm_tid,
    })
    .from(PosPaytmTransaction)
    .where(
      and(
        eq(PosPaytmTransaction.order_id, BigInt(orderId)),
        inArray(PosPaytmTransaction.platform, ['txn_created', 'txn_completed']),
      ),
    )
    .orderBy(asc(PosPaytmTransaction.id))
    .limit(201)
    .for('update');
  for (const row of paytm)
    records.push({
      ...row,
      provider: 'paytm',
      id: String(row.id),
      storeId: String(row.storeId),
      providerReference: row.transactionId,
      storePosCode: '',
      imei: '',
      onlineAmount: String(row.onlineAmount),
      cashAmount: String(row.cashAmount),
      cashReceived: String(row.cashReceived),
    });
  const indexed = new Map(
    records
      .filter((record) => record.platform === 'txn_created')
      .map((record) => [`${record.provider}:${record.id}`, record]),
  );
  for (const attempt of attempts) {
    if (!attempt.legacySource) continue;
    const original = indexed.get(
      `${attempt.legacySource.provider}:${attempt.legacySource.legacyId}`,
    );
    if (
      !original ||
      legacyPaymentSourceHash(original, hashSecret, attempt.legacySource.version) !==
        attempt.legacySource.inputHash
    )
      throw legacyReview();
  }
  return { attempts, records, ...legacyPaymentEvidence(records, attempts) };
}

export function paymentRepository(
  db: Databases,
  config: Config,
  options: PaymentRepositoryOptions,
) {
  // Only database work is retried here; all provider calls remain in the service outside these transactions.
  const transact = <T>(work: (tx: PaymentTransaction) => Promise<T>) =>
    retryTransaction(() => db.get('writer').transaction(work));
  async function rejectCancelledOrder(tx: PaymentTransaction, orderId: string) {
    const [cancelled] = await tx
      .select({ id: pendingOrderCancellations.id })
      .from(pendingOrderCancellations)
      .where(eq(pendingOrderCancellations.orderId, orderId))
      .limit(1);
    if (cancelled)
      throw new AppError(
        409,
        'ORDER_CANCELLATION_RECORDED',
        'This order has an immutable cancellation. Another payment cannot be collected.',
      );
  }
  async function rejectOfflineCashSettlement(tx: PaymentTransaction, orderId: string) {
    const [evidence] = await tx
      .select({ linkId: offlineCashOrderLinks.receiptId, receiptId: offlineCashReceipts.id })
      .from(Order)
      .leftJoin(offlineCashOrderLinks, eq(offlineCashOrderLinks.orderId, orderId))
      .leftJoin(offlineCashReceipts, eq(offlineCashReceipts.orderId, orderId))
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1);
    if (evidence?.linkId || evidence?.receiptId)
      throw new AppError(
        409,
        'ORDER_ALREADY_SETTLED_OFFLINE',
        'This order has an immutable completed cash receipt. Reconcile that receipt instead of collecting another payment.',
      );
  }
  const checkIns = checkInService(db, config),
    now = () =>
      (options.clock?.() ?? Temporal.Now.instant())
        .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' ');
  const assertCheckIn =
    options.assertCheckIn ||
    ((userId, storeId, counterId, tx) => checkIns.assertCheckIn(userId, storeId, counterId, tx));
  async function order(
    tx: PaymentTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
  ) {
    requireStore(user, storeId);
    // Check-in/current actor/store precede financial order locks, matching cancellation/day-close.
    // A nonlocking counter preflight here would establish an old REPEATABLE READ
    // snapshot before waiting for another payment and could hide its new attempt.
    await assertCheckIn(user.id, storeId, undefined, tx);
    await assertCurrentStoreAccess(tx, user.id, storeId);
    // Same Store lock as correction/day-close, before order and payment locks.
    await tx
      .select({ id: Store.id })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .for('update');
    const [record] = await tx
      .select({
        mappingId: OrderStore.id,
        counter: OrderStore.counter,
        reference: Order.order_ref_no,
        payable: Order.pay_amt,
        paymentStatus: Order.payment_statuses,
        orderStatus: Order.order_statuses,
        createdAt: Order.created_at,
        method: Order.payment_methods,
        manuallyPaid: OrderStore.is_manually_paid,
        cash: OrderStore.offline_payment,
        online: OrderStore.online_payment,
        other: OrderStore.online_other_payment,
        transactionId: OrderStore.transaction_id,
        cashReceived: OrderStore.offline_payment_recieved,
      })
      .from(OrderStore)
      .innerJoin(Order, eq(Order.id, OrderStore.order))
      .where(and(eq(OrderStore.store, BigInt(storeId)), eq(OrderStore.order, BigInt(orderId))))
      .for('update');
    if (!record) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found in this store.');
    await assertCheckIn(user.id, storeId, String(record.counter), tx);
    return record;
  }
  const effective = (tx: PaymentTransaction, attempts: PaymentAttempt[]) =>
    options.corrections ? options.corrections.effective(tx, attempts) : Promise.resolve(attempts);
  const history = async (tx: PaymentTransaction, orderId: string) => {
    const raw = await readOrderPaymentEvidence(tx, orderId, options.hashSecret);
    return { ...raw, attempts: await effective(tx, raw.attempts) };
  };
  function assertUnpaid(mapping: Awaited<ReturnType<typeof order>>) {
    if (
      mapping.method !== 14n ||
      mapping.paymentStatus !== 1n ||
      mapping.orderStatus !== 1n ||
      mapping.manuallyPaid ||
      [mapping.cash, mapping.online, mapping.other].some((value) => minorUnits(String(value)) > 0n)
    )
      throw new AppError(
        409,
        'ORDER_NOT_PAYABLE',
        'This order has a settlement or status that needs review before taking payment.',
      );
  }
  async function assertPayable(
    tx: PaymentTransaction,
    mapping: Awaited<ReturnType<typeof order>>,
    storeId: string,
    orderId: string,
  ) {
    await rejectCancelledOrder(tx, orderId);
    await rejectOfflineCashSettlement(tx, orderId);
    assertUnpaid(mapping);
    assertCheckoutProjectionReady(options.projection);
    assertRefundAllocationReady(options.projection);
    await assertCheckoutProjection(tx, { orderId, storeId, counterId: String(mapping.counter) });
  }
  async function assertPaid(
    tx: PaymentTransaction,
    mapping: Awaited<ReturnType<typeof order>>,
    attempt: PaymentAttempt,
  ) {
    if (attempt.status !== 'paid') return;
    if (
      mapping.paymentStatus !== 4n ||
      mapping.orderStatus !== 3n ||
      mapping.transactionId !== attempt.transactionId ||
      minorUnits(mapping.cash) !== minorUnits(attempt.cashAmount) ||
      minorUnits(mapping.cashReceived) !== minorUnits(attempt.cashReceived) ||
      minorUnits(mapping.online) + minorUnits(mapping.other) !== minorUnits(attempt.onlineAmount)
    )
      throw new AppError(
        409,
        'PAYMENT_COMPLETION_CHANGED',
        'The settled order state changed. Review this payment before handing over the sale.',
      );
    await assertCheckoutProjection(tx, {
      orderId: attempt.orderId,
      storeId: attempt.storeId,
      counterId: String(mapping.counter),
    });
  }
  async function terminal(
    tx: PaymentTransaction,
    attempt: Pick<PaymentAttempt, 'channel' | 'machineId' | 'storeId' | 'counterId'>,
  ): Promise<Terminal | null> {
    if (!terminalPayment(attempt.channel)) return null;
    if (!attempt.machineId)
      throw new AppError(409, 'PAYMENT_MACHINE_REQUIRED', 'This payment has no terminal.');
    if (attempt.channel.startsWith('pine-')) {
      const [machine] = await tx
        .select()
        .from(PosMachine)
        .where(
          and(
            eq(PosMachine.id, BigInt(attempt.machineId)),
            eq(PosMachine.store_id, Number(attempt.storeId)),
            eq(PosMachine.counter_id, Number(attempt.counterId)),
            eq(PosMachine.is_active, 1),
          ),
        )
        .limit(1);
      if (!machine)
        throw new AppError(
          409,
          'PAYMENT_MACHINE_UNAVAILABLE',
          'This terminal is inactive or belongs to another counter.',
        );
      return {
        provider: 'pine',
        id: String(machine.id),
        merchantId: machine.merchant_id,
        securityToken: machine.security_token,
        clientId: machine.client_id,
        storePosCode: machine.merchant_store_pos_code,
        imei: machine.imei_no,
      };
    }
    const [machine] = await tx
      .select()
      .from(PosPaytmMachine)
      .where(
        and(
          eq(PosPaytmMachine.id, BigInt(attempt.machineId)),
          eq(PosPaytmMachine.store_id, Number(attempt.storeId)),
          eq(PosPaytmMachine.counter_id, Number(attempt.counterId)),
          eq(PosPaytmMachine.is_active, 1),
        ),
      )
      .limit(1);
    if (!machine)
      throw new AppError(
        409,
        'PAYMENT_MACHINE_UNAVAILABLE',
        'This terminal is inactive or belongs to another counter.',
      );
    return {
      provider: 'paytm',
      id: String(machine.id),
      merchantKey: machine.merchant_key,
      mid: machine.paytm_mid,
      tid: machine.paytm_tid,
      channelId: machine.channel_id,
    };
  }
  async function owned(
    tx: PaymentTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    id: string,
    purpose: 'authority' | 'evidence' = 'authority',
  ) {
    const mapping = await order(tx, user, storeId, orderId);
    const [row] = await tx
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.id, id),
          eq(paymentAttempts.orderId, orderId),
          eq(paymentAttempts.storeId, storeId),
        ),
      )
      .for('update');
    if (!row)
      throw new AppError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'Payment attempt was not found.');
    const [attempt] = await effective(tx, [storedPaymentAttemptSchema.parse(row.state)]);
    if (!attempt)
      throw new AppError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'Payment attempt was not found.');
    if (attempt.legacySource && purpose === 'authority') {
      await history(tx, orderId);
    }
    return { attempt, mapping };
  }
  async function save(tx: PaymentTransaction, attempt: PaymentAttempt, timestamp = now()) {
    const next = { ...attempt, updatedAt: timestamp };
    await tx
      .update(paymentAttempts)
      .set({ state: next, status: next.status, updatedAt: next.updatedAt })
      .where(eq(paymentAttempts.id, next.id));
    return next;
  }
  async function terminalAudit(
    tx: PaymentTransaction,
    attempt: PaymentAttempt,
    machine: NonNullable<PaymentDispatchFrame['device']> | null,
    platform: string,
    code: string,
  ) {
    if (!machine) return;
    const common = {
      order_id: BigInt(attempt.orderId),
      store_id: BigInt(attempt.storeId),
      transaction_id: attempt.transactionId,
      amount: attempt.onlineAmount,
      cash_amount: attempt.cashAmount,
      cash_recieved: attempt.cashReceived,
      total_amount: amount(minorUnits(attempt.onlineAmount) + minorUnits(attempt.cashAmount)),
      payment_mode: paymentMode(attempt.channel),
      pos_admin_id: BigInt(attempt.operatorId),
      platform,
      api_response: JSON.stringify({ code }),
      is_active: platform === 'txn_created',
      created_at: now(),
      updated_at: now(),
    };
    if (machine.provider === 'pine')
      await tx.insert(PosTerminalTransaction).values({
        ...common,
        plutus_id: attempt.providerReference || '',
        store_pos_code: machine.storePosCode,
        imei: machine.imei,
      });
    else
      await tx.insert(PosPaytmTransaction).values({
        ...common,
        paytm_mid: machine.mid,
        paytm_tid: machine.tid,
        transaction_date_time: attempt.createdAt,
      });
  }
  async function complete(
    tx: PaymentTransaction,
    user: Principal,
    attempt: PaymentAttempt,
    mapping: Awaited<ReturnType<typeof order>>,
  ) {
    await rejectOfflineCashSettlement(tx, attempt.orderId);
    await rejectCancelledOrder(tx, attempt.orderId);
    if (mapping.paymentStatus !== 4n) assertUnpaid(mapping);
    await assertCheckoutProjection(tx, {
      orderId: attempt.orderId,
      storeId: attempt.storeId,
      counterId: String(mapping.counter),
    });
    validatePaymentSplit(
      {
        ...attempt,
        operationId: attempt.id,
        machineId: attempt.machineId || undefined,
        externalReference: attempt.externalReference || undefined,
        checkoutNote: attempt.checkoutNote
          ? { checkoutId: attempt.checkoutNote.checkoutId, noteHash: attempt.checkoutNote.noteHash }
          : undefined,
      },
      String(mapping.payable),
    );
    if (mapping.paymentStatus === 4n)
      throw new AppError(
        409,
        'ORDER_ALREADY_PAID',
        'This order was already paid. Reconcile the payment before recording another settlement.',
      );
    const [status] = await tx
      .select({ name: OrderStatus.order_status })
      .from(OrderStatus)
      .where(eq(OrderStatus.id, 3n))
      .limit(1);
    if (!status)
      throw new AppError(503, 'ORDER_STATUS_UNAVAILABLE', 'Delivered order status is missing.');
    const timestamp = now(),
      other = ['other', 'district', 'pincode'].includes(attempt.channel),
      cash = minorUnits(attempt.cashAmount),
      online = minorUnits(attempt.onlineAmount),
      total = amount(cash + online);
    const managedCorrection = await options.corrections?.recordSettlement(tx, attempt, timestamp);
    await tx
      .update(Order)
      .set({ payment_statuses: 4n, order_statuses: 3n })
      .where(eq(Order.id, BigInt(attempt.orderId)));
    await tx
      .update(OrderStore)
      .set({
        is_manually_paid: true,
        transaction_id: attempt.transactionId,
        message: attempt.checkoutNote?.message ?? 'Complete',
        offline_payment: attempt.cashAmount,
        offline_payment_recieved: attempt.cashReceived,
        online_payment: other ? '0.00' : attempt.onlineAmount,
        online_other_payment: other ? attempt.onlineAmount : '0.00',
        district_transaction_id:
          attempt.channel === 'district' ? attempt.externalReference || '' : '',
        credit_pincode_id: attempt.channel === 'pincode' ? attempt.externalReference || '' : '',
      })
      .where(eq(OrderStore.id, mapping.mappingId));
    await tx
      .update(HasProduct)
      .set({ status: status.name })
      .where(eq(HasProduct.order, BigInt(attempt.orderId)));
    await tx
      .update(GiftVoucher)
      .set({ status: 1 })
      .where(sql`${GiftVoucher.order_id} = ${attempt.orderId}`);
    await recordGiftCardIssuance(tx, attempt.orderId);
    await tx.insert(Comments).values({
      order_id: BigInt(attempt.orderId),
      status_id: 3n,
      comment: `Store Order: ${status.name} status changed by pos admin.`,
      notify: 0,
      user_id: BigInt(user.id),
      package_details: '',
      created_at: timestamp,
      updated_at: timestamp,
      has_product_id: 0n,
      prod_id: 0n,
    });
    await tx.insert(PosTransactionLog).values({
      order_id: BigInt(attempt.orderId),
      store_id: BigInt(attempt.storeId),
      order_status: 3n,
      payment_status: 4n,
      user_id: 0n,
      pos_user_id: BigInt(user.id),
      pay_dict: JSON.stringify({
        'cash payment': Number(attempt.cashAmount),
        [other ? 'online payment (others)' : 'online payment']: Number(attempt.onlineAmount),
        'total amount on counter': Number(total),
      }),
      comment: `Order Delivered : Total Amount Recieved at Counter ${other ? 'online (others)' : 'in Cash'}: ${Number(total)}`,
      created_at: timestamp,
      updated_at: timestamp,
    });
    if (!managedCorrection)
      await tx
        .update(StoreDayClose)
        .set({
          status: 'STALE',
          stale_at: timestamp,
          stale_reason: 'PAYMENT',
          stale_trigger_ref: attempt.orderId,
          updated_at: timestamp,
        })
        .where(
          and(
            eq(StoreDayClose.store_id, Number(attempt.storeId)),
            eq(StoreDayClose.close_date, mapping.createdAt.slice(0, 10)),
            eq(StoreDayClose.status, 'CLOSED'),
          ),
        );
    for (const kind of ['order-kinesis', 'order-engagement']) {
      if (managedCorrection) {
        // Payment-only correction does not create a second sale. Retain the first
        // confirmed downstream finalization; unknown deliveries cannot be corrected.
        const [delivered] = await tx
          .select({ id: paymentOutbox.id })
          .from(paymentOutbox)
          .where(
            and(
              eq(paymentOutbox.orderId, attempt.orderId),
              eq(paymentOutbox.kind, kind),
              eq(paymentOutbox.status, 'delivered'),
            ),
          )
          .limit(1)
          .for('update');
        if (delivered) continue;
      }
      await tx
        .insert(paymentOutbox)
        .values({
          id: `${attempt.id}:${kind}`,
          kind,
          orderId: attempt.orderId,
          storeId: attempt.storeId,
          status: 'pending',
          requestId: currentRequestTrace()?.requestId || null,
          operatorId: user.id,
          createdAt: timestamp,
        })
        .onDuplicateKeyUpdate({ set: { id: sql`${paymentOutbox.id}` } });
    }
    return timestamp;
  }
  return {
    async paymentContext(user: Principal, storeId: string, orderId: string) {
      return transact(async (tx) => {
        const mapping = await order(tx, user, storeId, orderId),
          evidence = await history(tx, orderId);
        const active = evidence.attempts.find(
          (attempt) => !['failed', 'cancelled', 'reversed'].includes(attempt.status),
        );
        let blocker: string | null = null;
        try {
          await assertPayable(tx, mapping, storeId, orderId);
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          blocker = error.code;
        }
        if (evidence.completed || evidence.ambiguous) blocker = 'LEGACY_PAYMENT_REVIEW_REQUIRED';
        if (active?.status === 'paid') await assertPaid(tx, mapping, active);
        return {
          orderId,
          storeId,
          counterId: String(mapping.counter),
          payable: String(mapping.payable),
          canRecordPayment: !blocker && !active && evidence.candidates.length === 0,
          activeAttemptId: active?.id || null,
          legacyPayment:
            !blocker && !active && evidence.candidates.length === 1
              ? { provider: evidence.candidates[0]!.provider, legacyId: evidence.candidates[0]!.id }
              : null,
          blocker,
        };
      });
    },
    async adoptLegacy(
      user: Principal,
      storeId: string,
      orderId: string,
      input: LegacyPaymentRecoveryInput,
    ) {
      return transact(async (tx) => {
        const mapping = await order(tx, user, storeId, orderId),
          hash = operationHash(
            'payment.legacy.adopt',
            { storeId, orderId, input },
            options.hashSecret,
          );
        const [existing] = await tx
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, input.operationId))
          .for('update');
        if (existing) {
          const [attempt] = await effective(tx, [storedPaymentAttemptSchema.parse(existing.state)]);
          if (!attempt)
            throw new AppError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'Payment attempt was not found.');
          if (
            attempt.operatorId !== user.id ||
            attempt.storeId !== storeId ||
            attempt.orderId !== orderId ||
            attempt.requestHash !== hash
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This recovery key was used with different data.',
            );
          await assertPaid(tx, mapping, attempt);
          return attempt;
        }
        await assertPayable(tx, mapping, storeId, orderId);
        const evidence = await history(tx, orderId);
        if (
          evidence.completed ||
          evidence.ambiguous ||
          evidence.attempts.some((attempt) => !['failed', 'cancelled'].includes(attempt.status))
        )
          throw legacyReview();
        const source = evidence.candidates.find(
          (row) => row.provider === input.provider && row.id === input.legacyId,
        );
        if (
          !source ||
          source.storeId !== storeId ||
          !/^[A-Za-z0-9_-]{1,32}$/.test(source.transactionId)
        )
          throw legacyReview();
        const amounts = normalizedLegacyAmounts(source),
          channel = legacyChannel(source);
        let machineId: string;
        if (source.provider === 'pine') {
          if (
            !source.providerReference ||
            ['0', 'NIL'].includes(source.providerReference) ||
            !source.storePosCode ||
            !source.imei
          )
            throw legacyReview();
          const machines = await tx
            .select({ id: PosMachine.id })
            .from(PosMachine)
            .where(
              and(
                eq(PosMachine.store_id, Number(storeId)),
                eq(PosMachine.counter_id, Number(mapping.counter)),
                eq(PosMachine.is_active, 1),
                eq(PosMachine.merchant_store_pos_code, source.storePosCode),
                eq(PosMachine.imei_no, source.imei),
              ),
            )
            .limit(2)
            .for('share');
          if (machines.length !== 1) throw legacyReview();
          machineId = String(machines[0]!.id);
        } else {
          if (!source.mid || !source.tid) throw legacyReview();
          const machines = await tx
            .select({ id: PosPaytmMachine.id })
            .from(PosPaytmMachine)
            .where(
              and(
                eq(PosPaytmMachine.store_id, Number(storeId)),
                eq(PosPaytmMachine.counter_id, Number(mapping.counter)),
                eq(PosPaytmMachine.is_active, 1),
                eq(PosPaytmMachine.paytm_mid, source.mid),
                eq(PosPaytmMachine.paytm_tid, source.tid),
              ),
            )
            .limit(2)
            .for('share');
          if (machines.length !== 1) throw legacyReview();
          machineId = String(machines[0]!.id);
        }
        validatePaymentSplit(
          { ...amounts, channel, machineId, operationId: input.operationId },
          String(mapping.payable),
        );
        const date = now(),
          sourceHash = legacyPaymentSourceHash(source, options.hashSecret, 1),
          attempt: PaymentAttempt = {
            id: input.operationId,
            operatorId: user.id,
            storeId,
            counterId: String(mapping.counter),
            orderId,
            channel,
            ...amounts,
            machineId,
            externalReference: null,
            transactionId: source.transactionId,
            providerReference: source.providerReference,
            legacySource: {
              version: 1,
              provider: input.provider,
              legacyId: input.legacyId,
              inputHash: sourceHash,
            },
            status: 'uncertain',
            busyOperationId: null,
            requestHash: hash,
            errorCode: 'LEGACY_PAYMENT_STATUS_REQUIRED',
            createdAt: date,
            updatedAt: date,
          };
        await tx.insert(legacyPaymentRecoveries).values({
          provider: input.provider,
          legacyId: input.legacyId,
          attemptId: attempt.id,
          orderId,
          storeId,
          operatorId: user.id,
          requestHash: hash,
          requestId: currentRequestTrace()?.requestId || null,
          createdAt: date,
        });
        await tx.insert(paymentAttempts).values({
          id: attempt.id,
          orderId,
          storeId,
          operatorId: user.id,
          status: attempt.status,
          state: attempt,
          createdAt: date,
          updatedAt: date,
        });
        return attempt;
      });
    },
    async begin(user: Principal, storeId: string, orderId: string, input: PaymentInput) {
      return transact(async (tx) => {
        const mapping = await order(tx, user, storeId, orderId),
          hash = operationHash('payment.start', { storeId, orderId, input }, options.hashSecret);
        const [existing] = await tx
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, input.operationId))
          .for('update');
        if (existing) {
          const [attempt] = await effective(tx, [storedPaymentAttemptSchema.parse(existing.state)]);
          if (!attempt)
            throw new AppError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'Payment attempt was not found.');
          if (
            attempt.storeId !== storeId ||
            attempt.orderId !== orderId ||
            attempt.operatorId !== user.id ||
            attempt.requestHash !== hash
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This payment key was used with different data.',
            );
          await assertPaid(tx, mapping, attempt);
          return { attempt, machine: null, replay: true };
        }
        if (mapping.paymentStatus === 4n || mapping.orderStatus === 4n)
          throw new AppError(409, 'ORDER_NOT_PAYABLE', 'This order is already paid or cancelled.');
        await assertPayable(tx, mapping, storeId, orderId);
        await options.corrections?.assertStart(tx, orderId, input.channel);
        validatePaymentSplit(input, String(mapping.payable));
        let checkoutNote: PaymentAttempt['checkoutNote'] = null;
        if (input.checkoutNote) {
          const [saved] = await tx
            .select({ state: checkoutSessions.state })
            .from(checkoutSessions)
            .where(eq(checkoutSessions.id, input.checkoutNote.checkoutId))
            .for('update');
          const parsed = checkoutStateSchema.safeParse(saved?.state),
            state = parsed.success ? parsed.data : null,
            note = state?.settlementNote;
          if (
            !state ||
            state.operatorId !== user.id ||
            state.storeId !== storeId ||
            state.counterId !== String(mapping.counter) ||
            state.orderId !== orderId ||
            state.phase !== 'submitted' ||
            !note ||
            note.hash !== input.checkoutNote.noteHash ||
            note.payable !== amount(minorUnits(input.cashAmount)) ||
            note.cashReceived !== amount(minorUnits(input.cashReceived)) ||
            input.channel !== 'cash' ||
            minorUnits(input.onlineAmount) !== 0n
          )
            throw new AppError(
              409,
              'PAYMENT_NOTE_MISMATCH',
              'The payment note does not match this original checkout and cash amount.',
            );
          checkoutNote = {
            checkoutId: state.id,
            noteHash: note.hash,
            message: note.message,
          };
        }
        if (input.channel !== 'cash') {
          const platform = input.channel.startsWith('pine-')
            ? 'PINELAB'
            : input.channel.startsWith('paytm-')
              ? 'PAYTM'
              : 'OTHERS';
          const [mode] = await tx
            .select({ id: PosTerminalPaymentModes.id })
            .from(PosTerminalPaymentModes)
            .where(
              and(
                eq(PosTerminalPaymentModes.mode_id, paymentMode(input.channel)),
                eq(PosTerminalPaymentModes.platform, platform),
                eq(PosTerminalPaymentModes.is_active, 1),
              ),
            )
            .limit(1);
          if (!mode)
            throw new AppError(
              409,
              'PAYMENT_METHOD_UNAVAILABLE',
              'This payment method is currently disabled.',
            );
        }
        const legacy = await history(tx, orderId),
          active = legacy.attempts.find(
            (attempt) => !['failed', 'cancelled', 'reversed'].includes(attempt.status),
          );
        if (active)
          throw new AppError(
            409,
            'PAYMENT_ALREADY_ACTIVE',
            'Reconcile the existing payment before taking another payment.',
          );
        if (legacy.completed || legacy.ambiguous || legacy.candidates.length)
          throw new AppError(
            409,
            'LEGACY_PAYMENT_ACTIVE',
            'An earlier terminal payment needs reconciliation before another payment can start.',
          );
        const previous = await tx
          .select({ id: paymentAttempts.id })
          .from(paymentAttempts)
          .where(eq(paymentAttempts.orderId, orderId));
        const base = (mapping.reference || orderId).replaceAll('-', ''),
          transactionId =
            (base.length >= 8 ? base : base.padStart(8, '0')) +
            (previous.length ? String(previous.length + 1) : '');
        if (transactionId.length > 32)
          throw new AppError(
            409,
            'PAYMENT_REFERENCE_TOO_LONG',
            'The payment reference exceeds the provider limit.',
          );
        const timestamp = now(),
          attempt: PaymentAttempt = {
            id: input.operationId,
            operatorId: user.id,
            storeId,
            counterId: String(mapping.counter),
            orderId,
            channel: input.channel,
            onlineAmount: amount(minorUnits(input.onlineAmount)),
            cashAmount: amount(minorUnits(input.cashAmount)),
            cashReceived: amount(minorUnits(input.cashReceived)),
            checkoutNote,
            machineId: input.machineId || null,
            externalReference: input.externalReference || null,
            transactionId,
            providerReference: null,
            status: 'dispatching',
            busyOperationId: input.operationId,
            requestHash: hash,
            errorCode: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
        const machine = await terminal(tx, attempt);
        await tx.insert(paymentAttempts).values({
          id: attempt.id,
          orderId,
          storeId,
          operatorId: user.id,
          status: attempt.status,
          state: attempt,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        return { attempt, machine, replay: false };
      });
    },
    async get(user: Principal, storeId: string, orderId: string, id: string) {
      return transact(async (tx) => {
        const { attempt, mapping } = await owned(tx, user, storeId, orderId, id);
        await assertPaid(tx, mapping, attempt);
        return attempt;
      });
    },
    async list(user: Principal, storeId: string, orderId: string) {
      return transact(async (tx) => {
        const mapping = await order(tx, user, storeId, orderId);
        const rows = await tx
          .select({ state: paymentAttempts.state })
          .from(paymentAttempts)
          .where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.storeId, storeId)))
          .orderBy(desc(paymentAttempts.createdAt), desc(paymentAttempts.id))
          .limit(20);
        const attempts = await effective(
            tx,
            rows.map((row) => storedPaymentAttemptSchema.parse(row.state)),
          ),
          paid = attempts.find((attempt) => attempt.status === 'paid');
        if (paid) await assertPaid(tx, mapping, paid);
        return attempts;
      });
    },
    async options(user: Principal, storeId: string, orderId: string) {
      return transact(async (tx) => {
        const mapping = await order(tx, user, storeId, orderId),
          modes = await tx
            .select({
              name: PosTerminalPaymentModes.name,
              mode: PosTerminalPaymentModes.mode_id,
              platform: PosTerminalPaymentModes.platform,
            })
            .from(PosTerminalPaymentModes)
            .where(eq(PosTerminalPaymentModes.is_active, 1))
            .orderBy(asc(PosTerminalPaymentModes.id));
        const pine = await tx
          .select({ id: PosMachine.id, name: PosMachine.machine_name })
          .from(PosMachine)
          .where(
            and(
              eq(PosMachine.store_id, Number(storeId)),
              eq(PosMachine.counter_id, Number(mapping.counter)),
              eq(PosMachine.is_active, 1),
            ),
          )
          .orderBy(asc(PosMachine.id));
        const paytm = await tx
          .select({ id: PosPaytmMachine.id, name: PosPaytmMachine.machine_name })
          .from(PosPaytmMachine)
          .where(
            and(
              eq(PosPaytmMachine.store_id, Number(storeId)),
              eq(PosPaytmMachine.counter_id, Number(mapping.counter)),
              eq(PosPaytmMachine.is_active, 1),
            ),
          )
          .orderBy(asc(PosPaytmMachine.id));
        const result: {
          channel: PaymentInput['channel'];
          label: string;
          machineId: string | null;
        }[] = [{ channel: 'cash', label: 'Cash', machineId: null }];
        for (const mode of modes) {
          const channel = channelForMode(mode.mode);
          if (!channel) continue;
          const machines =
            mode.platform === 'PINELAB' ? pine : mode.platform === 'PAYTM' ? paytm : null;
          if (machines)
            for (const machine of machines)
              result.push({
                channel,
                label: `${mode.name} (${machine.name})`,
                machineId: String(machine.id),
              });
          else if (mode.platform === 'OTHERS')
            result.push({ channel, label: mode.name, machineId: null });
        }
        return {
          payable: String(mapping.payable),
          counterId: String(mapping.counter),
          options: (await options.corrections?.restrictedToCash(tx, orderId))
            ? result.filter((option) => option.channel === 'cash')
            : result,
        };
      });
    },
    async context(user: Principal, storeId: string, orderId: string, id: string, cancel = false) {
      return transact(async (tx) => {
        const { attempt, mapping } = await owned(tx, user, storeId, orderId, id);
        await assertPaid(tx, mapping, attempt);
        if (['paid', 'cancelled', 'failed', 'reversed'].includes(attempt.status))
          return { attempt, machine: null };
        const age = Temporal.PlainDateTime.from(attempt.updatedAt.replace(' ', 'T'))
          .until(Temporal.PlainDateTime.from(now().replace(' ', 'T')))
          .total('seconds');
        if (attempt.busyOperationId && age < 60)
          throw new AppError(
            409,
            'PAYMENT_OPERATION_INFLIGHT',
            'The payment provider action is still being confirmed.',
          );
        const retained = attempt.providerEvidenceId
          ? await readPaymentProviderFact(tx, attempt, options.hashSecret)
          : null;
        const definitive =
          retained && ['paid', 'failed', 'cancelled'].includes(retained.value.decision.status)
            ? retained
            : null;
        const machine = definitive ? null : await terminal(tx, attempt);
        if (cancel && definitive)
          throw new AppError(
            409,
            'PAYMENT_REPLY_RECONCILIATION_REQUIRED',
            'Reconcile the retained provider response before cancelling.',
          );
        if (cancel && machine?.provider === 'paytm')
          throw new AppError(
            503,
            'PAYTM_CANCELLATION_UNCONFIRMED',
            'A provider-confirmed cancellation integration is required.',
          );
        if (cancel && attempt.status === 'cancelling')
          throw new AppError(
            409,
            'PAYMENT_CANCELLATION_UNCERTAIN',
            'The existing cancellation needs reconciliation.',
          );
        return {
          attempt: await save(tx, {
            ...attempt,
            busyOperationId: crypto.randomUUID(),
            ...(cancel ? { status: 'cancelling' as const } : {}),
          }),
          machine,
          ...(definitive
            ? { retainedDecision: definitive.value.decision, retainedFactId: definitive.id }
            : {}),
        };
      });
    },
    async decision(
      user: Principal,
      storeId: string,
      orderId: string,
      id: string,
      decision: ProviderDecision,
      machine: Terminal | null,
      busyOperationId: string | null,
      dispatchFrame?: PaymentDispatchFrame,
      retainedFactId?: string,
    ) {
      return transact(async (tx) => {
        const { attempt, mapping } = await owned(tx, user, storeId, orderId, id, 'evidence');
        const retained = retainedFactId
          ? await readPaymentProviderFact(tx, attempt, options.hashSecret)
          : null;
        if (
          retainedFactId &&
          (!retained ||
            retained.id !== retainedFactId ||
            JSON.stringify(retained.value.decision) !== JSON.stringify(decision))
        )
          throw new AppError(
            409,
            'PAYMENT_REPLY_PROVENANCE_REQUIRED',
            'The saved provider decision changed.',
          );
        if (attempt.legacySource) await history(tx, orderId);
        await assertPaid(tx, mapping, attempt);
        if (['paid', 'cancelled', 'failed', 'reversed'].includes(attempt.status)) return attempt;
        if (attempt.busyOperationId !== busyOperationId)
          throw new AppError(
            409,
            'PAYMENT_OPERATION_CHANGED',
            'A newer payment reconciliation superseded this provider response.',
          );
        const next: PaymentAttempt = {
          ...attempt,
          status: decision.status,
          busyOperationId: null,
          providerReference: decision.reference || attempt.providerReference,
          errorCode: decision.status === 'uncertain' ? decision.code : null,
          ...(retained ? { heldProviderDecision: undefined } : {}),
        };
        const completedAt =
          decision.status === 'paid' ? await complete(tx, user, next, mapping) : undefined;
        if (decision.status === 'pending' && attempt.status === 'dispatching')
          await terminalAudit(tx, next, machine, 'txn_created', decision.code);
        if (['paid', 'cancelled', 'failed'].includes(decision.status)) {
          const auditMachine = machine ?? retained?.value.frame.device ?? null;
          await terminalAudit(
            tx,
            next,
            auditMachine,
            decision.status === 'paid'
              ? 'txn_completed'
              : decision.status === 'cancelled'
                ? 'txn_force_cancelled'
                : 'txn_failed',
            decision.code,
          );
          const table =
            auditMachine?.provider === 'paytm' ? PosPaytmTransaction : PosTerminalTransaction;
          if (auditMachine)
            await tx
              .update(table)
              .set({ is_active: false })
              .where(
                and(
                  eq(table.order_id, BigInt(orderId)),
                  eq(table.transaction_id, next.transactionId),
                ),
              );
        }
        const saved = await save(tx, next, completedAt);
        return saved;
      }).catch(async (error: unknown) => {
        if (!dispatchFrame) throw error;
        await retainPaymentProviderFact(db, dispatchFrame, decision, options.hashSecret);
        throw error;
      });
    },
  };
}
export type PaymentRepository = ReturnType<typeof paymentRepository>;
