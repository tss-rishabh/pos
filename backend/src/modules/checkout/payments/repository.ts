import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { Decimal } from 'decimal.js';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  Comments,
  GiftVoucher,
  HasProduct,
  Order,
  OrderStatus,
  OrderStore,
  PaymentStatus,
  PosMachine,
  PosPaytmMachine,
  PosPaytmTransaction,
  PosTerminalTransaction,
  PosTerminalPaymentModes,
  PosTransactionLog,
  StoreDayClose,
  Store,
} from '../../../db/legacy-schema.js';
import { hasProductStatuses } from '../../../db/legacy-enums.js';
import { storedEnumValue } from '../../../db/legacy-columns.js';
import type { Principal } from '../../../domain/access.js';
import { requireRole, requireStore } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { amount, minorUnits } from '../../../domain/money.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { retryTransaction } from '../../../db/retry.js';
import {
  channelForMode,
  paymentModeOf,
  providerOf,
  type PaymentChannel,
  type PaymentInput,
  type PaymentStatusInput,
  type PaytmTerminal,
  type PineTerminal,
} from './contracts.js';
import { legacyPayDict, legacyTransactionId, pythonFloat } from './legacy.js';

export type PaymentTransaction = AdministrationTransaction;
export interface PaymentRepositoryOptions {
  clock?: () => Temporal.Instant;
  assertCheckIn?: (
    userId: string,
    storeId: string,
    counterId: string | undefined,
    transaction: PaymentTransaction,
  ) => Promise<void>;
  /** @deprecated Ignored. Rewrite proof/projection inputs kept only for existing call sites. */
  hashSecret?: string;
  /** @deprecated Ignored (legacy sends only Content-Type and Authorization). */
  projection?: unknown;
  /** @deprecated Ignored. The rewrite correction ledger is deleted. */
  corrections?: unknown;
}

const decimalOf = (value: string | number) => new Decimal(String(value));
/** A stored double as an exact two-decimal amount string. */
const money = (value: string | number) => amount(minorUnits(decimalOf(value).toFixed(2)));
/** Exact legacy amount check `amount + cash != pay_amount` (order/views.py:3043-3046). */
export function validatePaymentSplit(input: PaymentInput, payable: string | number) {
  const online = minorUnits(input.onlineAmount),
    cash = minorUnits(input.cashAmount);
  if (!decimalOf(input.onlineAmount).plus(input.cashAmount).equals(decimalOf(payable)))
    throw new AppError(422, 'PAYMENT_TOTAL_MISMATCH', 'Incorrect Pay amount.');
  if (online + cash === 0n)
    throw new AppError(409, 'PAYMENT_NOT_REQUIRED', 'This order has no amount to collect.');
  if (minorUnits(input.cashReceived) > 0n && minorUnits(input.cashReceived) < cash)
    throw new AppError(
      422,
      'INSUFFICIENT_CASH_RECEIVED',
      'Cash received must cover the cash portion.',
    );
  if ((input.channel === 'cash') !== (online === 0n))
    throw new AppError(422, 'PAYMENT_MODE_REQUIRED', 'Please Select Payment Mode.');
  if (input.channel === 'district' && !input.externalReference)
    throw new AppError(422, 'PAYMENT_REFERENCE_REQUIRED', 'Provide District Transaction ID');
  if (input.channel === 'pincode' && !input.externalReference)
    throw new AppError(422, 'PAYMENT_REFERENCE_REQUIRED', 'Provide Credit-Pincode Transaction ID');
}

/** Active `txn_created` provider row (the legacy "uploaded" payment). */
export interface ActiveTransaction {
  provider: 'pine' | 'paytm';
  id: string;
  storeId: string;
  transactionId: string;
  plutusId: string;
  storePosCode: string;
  mid: string;
  amount: string;
  cashAmount: string;
  cashReceived: string;
  paymentMode: number;
}
export interface PaymentOption {
  /** Legacy option value (`mode` or `mode-machineId`). */
  value: string;
  label: string;
  channel: PaymentChannel;
  paymentMode: number;
  machineId: string | null;
}
export interface CompletionInput {
  orderId: string;
  storeId: string;
  userId: string;
  transactionId: string;
  message: string;
  cash: string;
  cashReceived: string;
  amount: string;
  others: boolean;
  /** Terminal completions keep the message stored at upload and NULL district/pincode ids. */
  terminal: boolean;
  districtTransactionId: string | null;
  creditPincodeId: string | null;
}
type Provider = 'pine' | 'paytm';
const pythonSum = (left: string, right: string) => Number(left) + Number(right);

export function paymentRepository(
  db: Databases,
  config: Config,
  options: PaymentRepositoryOptions,
) {
  const transact = <T>(work: (tx: PaymentTransaction) => Promise<T>) =>
    retryTransaction(() => db.get('writer').transaction(work));
  const checkIns = checkInService(db, config);
  const now = () =>
    (options.clock?.() ?? Temporal.Now.instant())
      .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const assertCheckIn =
    options.assertCheckIn ||
    ((userId, storeId, counterId, tx) => checkIns.assertCheckIn(userId, storeId, counterId, tx));

  async function mapping(tx: PaymentTransaction, storeId: string, orderId: string) {
    const [record] = await tx
      .select({
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
        settledTransactionId: OrderStore.transaction_id,
      })
      .from(OrderStore)
      .innerJoin(Order, eq(Order.id, OrderStore.order))
      .where(and(eq(OrderStore.store, BigInt(storeId)), eq(OrderStore.order, BigInt(orderId))))
      .limit(1)
      .for('update');
    if (!record) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found in this store.');
    return record;
  }
  type Mapping = Awaited<ReturnType<typeof mapping>>;
  /** Store scope, current access and counter check-in precede the order lock. */
  async function order(tx: PaymentTransaction, user: Principal, storeId: string, orderId: string) {
    requireStore(user, storeId);
    await assertCheckIn(user.id, storeId, undefined, tx);
    await assertCurrentStoreAccess(tx, user.id, storeId);
    await tx
      .select({ id: Store.id })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .for('update');
    const record = await mapping(tx, storeId, orderId);
    await assertCheckIn(user.id, storeId, String(record.counter), tx);
    return record;
  }
  const isPaid = (record: Mapping) => record.paymentStatus === 4n;
  /** Rewrite money-safety guard: a settled/cancelled order is never settled again. */
  function assertUnpaid(record: Mapping) {
    if (
      record.method !== 14n ||
      record.paymentStatus !== 1n ||
      record.orderStatus !== 1n ||
      record.manuallyPaid ||
      [record.cash, record.online, record.other].some((value) => Number(value) > 0)
    )
      throw new AppError(
        409,
        'ORDER_NOT_PAYABLE',
        'This order is already paid, cancelled or has a recorded settlement.',
      );
  }
  async function activeRows(tx: PaymentTransaction, orderId: string): Promise<ActiveTransaction[]> {
    const pine = await tx
      .select()
      .from(PosTerminalTransaction)
      .where(
        and(
          eq(PosTerminalTransaction.order_id, BigInt(orderId)),
          eq(PosTerminalTransaction.platform, 'txn_created'),
          eq(PosTerminalTransaction.is_active, true),
        ),
      )
      .orderBy(asc(PosTerminalTransaction.id))
      .limit(20);
    const paytm = await tx
      .select()
      .from(PosPaytmTransaction)
      .where(
        and(
          eq(PosPaytmTransaction.order_id, BigInt(orderId)),
          eq(PosPaytmTransaction.platform, 'txn_created'),
          eq(PosPaytmTransaction.is_active, true),
        ),
      )
      .orderBy(asc(PosPaytmTransaction.id))
      .limit(20);
    return [
      ...pine.map((row) => ({
        provider: 'pine' as const,
        id: String(row.id),
        storeId: String(row.store_id),
        transactionId: row.transaction_id,
        plutusId: row.plutus_id,
        storePosCode: row.store_pos_code,
        mid: '',
        amount: row.amount,
        cashAmount: row.cash_amount,
        cashReceived: row.cash_recieved,
        paymentMode: row.payment_mode,
      })),
      ...paytm.map((row) => ({
        provider: 'paytm' as const,
        id: String(row.id),
        storeId: String(row.store_id),
        transactionId: row.transaction_id,
        plutusId: '',
        storePosCode: '',
        mid: row.paytm_mid,
        amount: row.amount,
        cashAmount: row.cash_amount,
        cashReceived: row.cash_recieved,
        paymentMode: row.payment_mode,
      })),
    ];
  }
  async function nextTransactionId(tx: PaymentTransaction, orderId: string, reference: string) {
    const count = async (provider: Provider, active: boolean) => {
      const table = provider === 'pine' ? PosTerminalTransaction : PosPaytmTransaction;
      const [row] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(table)
        .where(
          and(
            eq(table.order_id, BigInt(orderId)),
            eq(table.platform, 'txn_created'),
            eq(table.is_active, active),
          ),
        );
      return Number(row?.count ?? 0);
    };
    return legacyTransactionId({
      orderId,
      orderRefNo: reference,
      inactivePineCreated: await count('pine', false),
      inactivePaytmCreated: await count('paytm', false),
      activePaytmCreated: await count('paytm', true),
    });
  }
  function pineTerminal(machine: typeof PosMachine.$inferSelect): PineTerminal {
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
  function paytmTerminal(machine: typeof PosPaytmMachine.$inferSelect): PaytmTerminal {
    return {
      provider: 'paytm',
      id: String(machine.id),
      merchantKey: machine.merchant_key,
      mid: machine.paytm_mid,
      tid: machine.paytm_tid,
      channelId: machine.channel_id,
    };
  }
  /** Upload machine: the selected store machine, else the first active one (terminal_helpers.py:20-25). */
  async function uploadTerminal(
    tx: PaymentTransaction,
    provider: Provider,
    storeId: string,
    machineId: string | undefined,
  ) {
    if (provider === 'pine') {
      const [machine] = await tx
        .select()
        .from(PosMachine)
        .where(
          and(
            ...(machineId ? [eq(PosMachine.id, BigInt(machineId))] : []),
            eq(PosMachine.store_id, Number(storeId)),
            eq(PosMachine.is_active, 1),
          ),
        )
        .orderBy(asc(PosMachine.id))
        .limit(1);
      return machine ? pineTerminal(machine) : null;
    }
    const [machine] = await tx
      .select()
      .from(PosPaytmMachine)
      .where(
        and(
          ...(machineId ? [eq(PosPaytmMachine.id, BigInt(machineId))] : []),
          eq(PosPaytmMachine.store_id, Number(storeId)),
          eq(PosPaytmMachine.is_active, 1),
        ),
      )
      .orderBy(asc(PosPaytmMachine.id))
      .limit(1);
    return machine ? paytmTerminal(machine) : null;
  }
  async function transactionLog(
    tx: PaymentTransaction,
    entry: {
      orderId: string;
      storeId: string;
      userId: string;
      payDict: string;
      comment: string;
      statuses?: { order: bigint; payment: bigint };
    },
  ) {
    let statuses = entry.statuses;
    if (!statuses) {
      const [current] = await tx
        .select({ order: Order.order_statuses, payment: Order.payment_statuses })
        .from(Order)
        .where(eq(Order.id, BigInt(entry.orderId)))
        .limit(1);
      statuses = current ?? { order: 0n, payment: 0n };
    }
    const timestamp = now();
    await tx.insert(PosTransactionLog).values({
      order_id: BigInt(entry.orderId),
      store_id: BigInt(entry.storeId),
      order_status: statuses.order,
      payment_status: statuses.payment,
      user_id: 0n,
      pos_user_id: BigInt(entry.userId),
      pay_dict: entry.payDict,
      comment: entry.comment.slice(0, 255),
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  /** `mark_stale(store_id, order_close_date(order_id), reason, order_id)` (day_close_services.py:323-345). */
  async function markStale(
    tx: PaymentTransaction,
    storeId: string,
    orderId: string,
    createdAt: string | null,
    reason: string,
  ) {
    const timestamp = now();
    await tx
      .update(StoreDayClose)
      .set({
        status: 'STALE',
        stale_at: timestamp,
        stale_reason: reason,
        stale_trigger_ref: orderId,
        updated_at: timestamp,
      })
      .where(
        and(
          eq(StoreDayClose.store_id, Number(storeId)),
          eq(StoreDayClose.close_date, (createdAt ?? timestamp).slice(0, 10)),
          eq(StoreDayClose.status, 'CLOSED'),
        ),
      );
  }
  async function deliveredStatusName(tx: PaymentTransaction, id: bigint) {
    const [status] = await tx
      .select({ name: OrderStatus.order_status })
      .from(OrderStatus)
      .where(eq(OrderStatus.id, id))
      .limit(1);
    return status?.name ?? null;
  }
  /** `Helpers.complete_order` (helpers/helpers.py:625-709), one Drizzle transaction. */
  async function completeOrder(tx: PaymentTransaction, input: CompletionInput, record: Mapping) {
    const name = await deliveredStatusName(tx, 3n);
    if (name === null)
      throw new AppError(503, 'ORDER_STATUS_UNAVAILABLE', 'Delivered order status is missing.');
    const timestamp = now(),
      cash = Number(input.cash),
      online = Number(input.amount),
      total = cash + online;
    await tx
      .update(Order)
      .set({ payment_statuses: 4n, order_statuses: 3n })
      .where(eq(Order.id, BigInt(input.orderId)));
    await tx
      .update(OrderStore)
      .set({
        is_manually_paid: true,
        transaction_id: input.transactionId,
        ...(input.terminal ? {} : { message: input.message }),
        offline_payment: input.cash,
        offline_payment_recieved: input.cashReceived,
        online_payment: input.others ? '0' : input.amount,
        online_other_payment: input.others ? input.amount : '0',
        district_transaction_id: input.districtTransactionId,
        credit_pincode_id: input.creditPincodeId,
      })
      .where(eq(OrderStore.order, BigInt(input.orderId)));
    await tx.insert(Comments).values({
      order_id: BigInt(input.orderId),
      status_id: 3n,
      comment: `Store Order: ${name} status changed by pos admin.`,
      notify: 0,
      user_id: BigInt(input.userId),
      package_details: '',
      created_at: timestamp,
      updated_at: timestamp,
      has_product_id: 0n,
      prod_id: 0n,
    });
    await tx
      .update(GiftVoucher)
      .set({ status: 1 })
      .where(eq(GiftVoucher.order_id, BigInt(input.orderId)));
    await tx
      .update(HasProduct)
      .set({ status: storedEnumValue(hasProductStatuses, name) })
      .where(eq(HasProduct.order, BigInt(input.orderId)));
    await transactionLog(tx, {
      orderId: input.orderId,
      storeId: input.storeId,
      userId: input.userId,
      payDict: legacyPayDict([
        ['cash payment', cash],
        [input.others ? 'online payment (others)' : 'online payment', online],
        ['total amount on counter', total],
      ]),
      comment: input.others
        ? `Order Delivered : Total Amount Recieved at Counter online (others): ${pythonFloat(total)}`
        : `Order Delivered : Total Amount Recieved at Counter in Cash: ${pythonFloat(total)}`,
      statuses: { order: 3n, payment: 4n },
    });
    await markStale(tx, input.storeId, input.orderId, record.createdAt, 'PAYMENT');
  }
  /** `terminal_transaction_logger` / `paytm_transaction_logger` (terminal_helpers.py:244-261, 546-561). */
  async function providerRow(
    tx: PaymentTransaction,
    provider: Provider,
    row: {
      orderId: string;
      storeId: string;
      transactionId: string;
      amount: string;
      cash: string;
      cashReceived: string;
      paymentMode: number;
      userId: string;
      platform: string;
      apiResponse: string;
      plutusId?: string;
      storePosCode?: string;
      imei?: string;
      mid?: string;
      tid?: string;
      transactionDateTime?: string;
    },
  ) {
    const timestamp = now(),
      common = {
        order_id: BigInt(row.orderId),
        store_id: BigInt(row.storeId),
        transaction_id: row.transactionId,
        amount: row.amount,
        cash_amount: row.cash,
        cash_recieved: row.cashReceived,
        total_amount: String(pythonSum(row.amount, row.cash)),
        payment_mode: row.paymentMode,
        pos_admin_id: BigInt(row.userId),
        platform: row.platform,
        api_response: row.apiResponse,
        is_active: true,
        created_at: timestamp,
        updated_at: timestamp,
      };
    if (provider === 'pine')
      await tx.insert(PosTerminalTransaction).values({
        ...common,
        plutus_id: row.plutusId ?? '',
        store_pos_code: row.storePosCode ?? '',
        imei: row.imei ?? '',
      });
    else
      await tx.insert(PosPaytmTransaction).values({
        ...common,
        paytm_mid: row.mid ?? '',
        paytm_tid: row.tid ?? '',
        transaction_date_time: row.transactionDateTime ?? timestamp,
      });
  }
  async function deactivate(
    tx: PaymentTransaction,
    provider: Provider,
    orderId: string,
    transactionId: string,
  ) {
    const table = provider === 'pine' ? PosTerminalTransaction : PosPaytmTransaction;
    await tx
      .update(table)
      .set({ is_active: false, updated_at: now() })
      .where(and(eq(table.order_id, BigInt(orderId)), eq(table.transaction_id, transactionId)));
  }
  async function active(
    tx: PaymentTransaction,
    orderId: string,
    transactionId: string,
  ): Promise<ActiveTransaction | null> {
    return (
      (await activeRows(tx, orderId)).find((row) => row.transactionId === transactionId) ?? null
    );
  }

  return {
    now,
    /** Order payment state for the counter and order-details pages. */
    async paymentContext(user: Principal, storeId: string, orderId: string) {
      return transact(async (tx) => {
        const record = await order(tx, user, storeId, orderId),
          rows = await activeRows(tx, orderId),
          uploaded = rows[0] ?? null;
        let blocker: string | null = null;
        try {
          assertUnpaid(record);
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          blocker = isPaid(record) ? null : error.code;
        }
        return {
          orderId,
          storeId,
          counterId: String(record.counter),
          payable: money(record.payable),
          paid: isPaid(record),
          settlement: isPaid(record)
            ? {
                transactionId: record.settledTransactionId,
                cashAmount: money(record.cash),
                onlineAmount: amount(
                  minorUnits(money(record.online)) + minorUnits(money(record.other)),
                ),
              }
            : null,
          transactionId: await nextTransactionId(tx, orderId, record.reference ?? ''),
          activeTransaction: uploaded
            ? {
                provider: uploaded.provider,
                transactionId: uploaded.transactionId,
                reference: uploaded.provider === 'pine' ? uploaded.plutusId : null,
                onlineAmount: money(uploaded.amount),
                cashAmount: money(uploaded.cashAmount),
              }
            : null,
          canRecordPayment: !blocker && !isPaid(record) && !uploaded,
          blocker,
        };
      });
    },
    /** `TerminalHelper.get_payment_mode` (terminal_helpers.py:273-317). */
    async options(user: Principal, storeId: string, orderId: string) {
      return transact(async (tx) => {
        const record = await order(tx, user, storeId, orderId),
          counter = Number(record.counter);
        const modes = await tx
          .select({
            name: PosTerminalPaymentModes.name,
            mode: PosTerminalPaymentModes.mode_id,
            platform: PosTerminalPaymentModes.platform,
          })
          .from(PosTerminalPaymentModes)
          .where(eq(PosTerminalPaymentModes.is_active, 1))
          .orderBy(asc(PosTerminalPaymentModes.id));
        // Legacy dict semantics: a later row with the same name replaces the value in place.
        const byPlatform = new Map<string, Map<string, number>>();
        for (const mode of modes) {
          const group = byPlatform.get(mode.platform) ?? new Map<string, number>();
          group.set(mode.name, mode.mode);
          byPlatform.set(mode.platform, group);
        }
        const machineScope = <T extends typeof PosMachine | typeof PosPaytmMachine>(table: T) =>
          and(
            eq(table.store_id, Number(storeId)),
            ...(counter ? [eq(table.counter_id, counter)] : []),
            eq(table.is_active, 1),
          );
        const result = new Map<string, { value: string; mode: number; machineId: string | null }>();
        for (const [name, mode] of byPlatform.get('OTHERS') ?? [])
          result.set(name, { value: String(mode), mode, machineId: String(mode) });
        if (byPlatform.get('PINELAB')?.size) {
          const machines = await tx
            .select({ id: PosMachine.id, name: PosMachine.machine_name })
            .from(PosMachine)
            .where(machineScope(PosMachine))
            .orderBy(asc(PosMachine.id));
          for (const machine of machines)
            for (const [name, mode] of byPlatform.get('PINELAB')!)
              result.set(`${name} (${machine.name})`, {
                value: `${mode}-${machine.id}`,
                mode,
                machineId: String(machine.id),
              });
        }
        if (byPlatform.get('PAYTM')?.size) {
          const machines = await tx
            .select({ id: PosPaytmMachine.id, name: PosPaytmMachine.machine_name })
            .from(PosPaytmMachine)
            .where(machineScope(PosPaytmMachine))
            .orderBy(asc(PosPaytmMachine.id));
          for (const machine of machines)
            for (const [name, mode] of byPlatform.get('PAYTM')!)
              result.set(`${name} (${machine.name})`, {
                value: `${mode}-${machine.id}`,
                mode,
                machineId: String(machine.id),
              });
        }
        // `N. name` numbering, as get_pinelab_and_paytm_payment_mode does for a store.
        const options: PaymentOption[] = [...result.entries()].map(([name, item], index) => {
          const channel = channelForMode(item.mode);
          return {
            value: item.value,
            label: `${index + 1}. ${name}`,
            channel,
            paymentMode: item.mode,
            // Fixed OTHERS modes carry no machine; any other mode is uploaded to the Pine
            // machine named by the value suffix, exactly as legacy `payment_mode_raw[-1]`.
            machineId: ['other', 'district', 'pincode'].includes(channel) ? null : item.machineId,
          };
        });
        return {
          payable: money(record.payable),
          counterId: String(record.counter),
          options,
        };
      });
    },
    /** Validation and dispatch preparation of `AjaxTransactionUploadView` (order/views.py:3020-3069). */
    async prepareStart(user: Principal, storeId: string, orderId: string, input: PaymentInput) {
      return transact(async (tx) => {
        const record = await order(tx, user, storeId, orderId);
        assertUnpaid(record);
        validatePaymentSplit(input, record.payable);
        if ((await activeRows(tx, orderId)).length)
          throw new AppError(
            409,
            'PAYMENT_ALREADY_UPLOADED',
            'A terminal payment for this order is waiting. Check its status or cancel it first.',
          );
        const provider = providerOf(input.channel),
          mode = paymentModeOf(input);
        if (provider !== 'cash') {
          const [row] = await tx
            .select({ id: PosTerminalPaymentModes.id })
            .from(PosTerminalPaymentModes)
            .where(
              and(
                eq(PosTerminalPaymentModes.mode_id, mode),
                eq(PosTerminalPaymentModes.is_active, 1),
              ),
            )
            .limit(1);
          if (!row)
            throw new AppError(
              409,
              'PAYMENT_METHOD_UNAVAILABLE',
              'This payment mode is currently disabled.',
            );
        }
        const transactionId = await nextTransactionId(tx, orderId, record.reference ?? '');
        if (transactionId.length > 45)
          throw new AppError(409, 'PAYMENT_REFERENCE_TOO_LONG', 'Provide a valid Transaction ID');
        const terminal =
          provider === 'pine' || provider === 'paytm'
            ? await uploadTerminal(tx, provider, storeId, input.machineId)
            : null;
        if ((provider === 'pine' || provider === 'paytm') && !terminal)
          throw new AppError(
            409,
            'PAYMENT_MACHINE_UNAVAILABLE',
            'Failed: the selected payment terminal is not active in this store.',
          );
        return { transactionId, terminal, provider, mode, counterId: String(record.counter) };
      });
    },
    /** Cash and Online (Others) branches: `complete_order(..., is_terminal=False)`. */
    async completeCounter(
      user: Principal,
      storeId: string,
      orderId: string,
      input: PaymentInput,
      transactionId: string,
    ) {
      return transact(async (tx) => {
        const record = await order(tx, user, storeId, orderId);
        assertUnpaid(record);
        validatePaymentSplit(input, record.payable);
        if ((await activeRows(tx, orderId)).length)
          throw new AppError(
            409,
            'PAYMENT_ALREADY_UPLOADED',
            'A terminal payment for this order is waiting. Check its status or cancel it first.',
          );
        const others = input.channel !== 'cash';
        await completeOrder(
          tx,
          {
            orderId,
            storeId,
            userId: user.id,
            transactionId,
            message: input.message ?? '',
            cash: input.cashAmount,
            cashReceived:
              minorUnits(input.cashReceived) === 0n ? input.cashAmount : input.cashReceived,
            amount: input.onlineAmount,
            others,
            terminal: false,
            districtTransactionId:
              input.channel === 'district' ? (input.externalReference ?? '') : '',
            creditPincodeId: input.channel === 'pincode' ? (input.externalReference ?? '') : '',
          },
          record,
        );
      });
    },
    /** Approved upload: `txn_created` row and `order_stores.message` (terminal_helpers.py:64-68, 393-396). */
    async recordUploaded(
      user: Principal,
      storeId: string,
      orderId: string,
      entry: {
        provider: Provider;
        transactionId: string;
        input: PaymentInput;
        paymentMode: number;
        apiResponse: string;
        plutusId?: string;
        terminal: PineTerminal | PaytmTerminal;
        transactionDateTime?: string;
      },
    ) {
      return transact(async (tx) => {
        requireStore(user, storeId);
        await mapping(tx, storeId, orderId);
        const cashReceived =
          minorUnits(entry.input.cashReceived) === 0n
            ? entry.input.cashAmount
            : entry.input.cashReceived;
        await providerRow(tx, entry.provider, {
          orderId,
          storeId,
          transactionId: entry.transactionId,
          amount: entry.input.onlineAmount,
          cash: entry.input.cashAmount,
          cashReceived,
          paymentMode: entry.paymentMode,
          userId: user.id,
          platform: 'txn_created',
          apiResponse: entry.apiResponse,
          ...(entry.terminal.provider === 'pine'
            ? {
                plutusId: entry.plutusId ?? '',
                storePosCode: entry.terminal.storePosCode,
                imei: entry.terminal.imei,
              }
            : {
                mid: entry.terminal.mid,
                tid: entry.terminal.tid,
                transactionDateTime: entry.transactionDateTime,
              }),
        });
        await tx
          .update(OrderStore)
          .set({ message: entry.input.message ?? '' })
          .where(eq(OrderStore.order, BigInt(orderId)));
      });
    },
    /** The active uploaded transaction and the machine legacy uses for status/cancel. */
    async uploaded(user: Principal, storeId: string, orderId: string, transactionId: string) {
      return transact(async (tx) => {
        await order(tx, user, storeId, orderId);
        const row = await active(tx, orderId, transactionId);
        if (!row) return null;
        if (row.provider === 'pine') {
          // terminal_helpers.py:93-98: machine by the row's POS code, else the first store machine.
          const [byCode] = row.storePosCode
            ? await tx
                .select()
                .from(PosMachine)
                .where(
                  and(
                    eq(PosMachine.merchant_store_pos_code, row.storePosCode),
                    eq(PosMachine.store_id, Number(row.storeId)),
                    eq(PosMachine.is_active, 1),
                  ),
                )
                .orderBy(asc(PosMachine.id))
                .limit(1)
            : [];
          const terminal = byCode
            ? pineTerminal(byCode)
            : await uploadTerminal(tx, 'pine', row.storeId, undefined);
          return { row, terminal };
        }
        const [machine] = await tx
          .select()
          .from(PosPaytmMachine)
          .where(
            and(
              eq(PosPaytmMachine.store_id, Number(row.storeId)),
              eq(PosPaytmMachine.paytm_mid, row.mid),
              eq(PosPaytmMachine.is_active, 1),
            ),
          )
          .orderBy(asc(PosPaytmMachine.id))
          .limit(1);
        return { row, terminal: machine ? paytmTerminal(machine) : null };
      });
    },
    /** Provider approved: completion row then `complete_order(..., is_terminal=True)`. */
    async completeTerminal(
      user: Principal,
      row: ActiveTransaction,
      orderId: string,
      entry: {
        apiResponse: string;
        terminal: PineTerminal | PaytmTerminal;
        transactionDateTime?: string;
      },
    ) {
      return transact(async (tx) => {
        const record = await mapping(tx, row.storeId, orderId);
        const current = await active(tx, orderId, row.transactionId);
        if (!current)
          throw new AppError(404, 'PAYMENT_TRANSACTION_NOT_FOUND', 'TRANSACTION NOT FOUND');
        // Paytm deactivates the upload before logging completion (terminal_helpers.py:496-501).
        if (row.provider === 'paytm') await deactivate(tx, 'paytm', orderId, row.transactionId);
        await providerRow(tx, row.provider, {
          orderId,
          storeId: row.storeId,
          transactionId: row.transactionId,
          amount: row.amount,
          cash: row.cashAmount,
          cashReceived: row.cashReceived,
          paymentMode: row.paymentMode,
          userId: user.id,
          platform: 'txn_completed',
          apiResponse: entry.apiResponse,
          ...(entry.terminal.provider === 'pine'
            ? {
                plutusId: row.plutusId,
                storePosCode: entry.terminal.storePosCode,
                imei: entry.terminal.imei,
              }
            : {
                mid: entry.terminal.mid,
                tid: entry.terminal.tid,
                transactionDateTime: entry.transactionDateTime,
              }),
        });
        // A second approval of an already settled order records the provider fact only.
        if (isPaid(record)) return false;
        await completeOrder(
          tx,
          {
            orderId,
            storeId: row.storeId,
            userId: user.id,
            transactionId: row.transactionId,
            message: 'Complete',
            cash: row.cashAmount,
            cashReceived: row.cashReceived,
            amount: row.amount,
            others: false,
            terminal: true,
            districtTransactionId: null,
            creditPincodeId: null,
          },
          record,
        );
        return true;
      });
    },
    /** Pine `INVALID PLUTUS TXN REF ID` (terminal_helpers.py:150-155). */
    async timedOut(user: Principal, row: ActiveTransaction, orderId: string) {
      return transact(async (tx) => {
        await deactivate(tx, 'pine', orderId, row.transactionId);
        await transactionLog(tx, {
          orderId,
          storeId: row.storeId,
          userId: user.id,
          payDict: '{}',
          comment: `Transaction Time Out for transaction Id : ${row.transactionId}`,
        });
      });
    },
    /** Paytm `0404` (terminal_helpers.py:527-532): logged, row left active as legacy. */
    async logOnly(user: Principal, row: ActiveTransaction, orderId: string, comment: string) {
      return transact((tx) =>
        transactionLog(tx, {
          orderId,
          storeId: row.storeId,
          userId: user.id,
          payDict: '{}',
          comment,
        }),
      );
    },
    /** Cancellation (terminal_helpers.py:211-222, 584-595). */
    async cancelled(
      user: Principal,
      row: ActiveTransaction,
      orderId: string,
      entry: {
        apiResponse: string;
        terminal: PineTerminal | null;
        mid?: string;
        tid?: string;
        now?: string;
      },
    ) {
      return transact(async (tx) => {
        await providerRow(tx, row.provider, {
          orderId,
          storeId: row.storeId,
          transactionId: row.transactionId,
          amount: row.amount,
          cash: row.cashAmount,
          cashReceived: row.cashReceived,
          paymentMode: row.provider === 'pine' ? 0 : row.paymentMode,
          userId: user.id,
          platform: row.provider === 'pine' ? 'txn_force_cancelled' : 'txn_cancelled',
          apiResponse: entry.apiResponse,
          ...(row.provider === 'pine'
            ? {
                plutusId: row.plutusId,
                storePosCode: entry.terminal?.storePosCode ?? row.storePosCode,
                imei: entry.terminal?.imei ?? '',
              }
            : { mid: entry.mid, tid: entry.tid, transactionDateTime: entry.now }),
        });
        await deactivate(tx, row.provider, orderId, row.transactionId);
        await transactionLog(tx, {
          orderId,
          storeId: row.storeId,
          userId: user.id,
          payDict: '{}',
          comment:
            row.provider === 'pine'
              ? `Transaction Force Cancelled for ${row.transactionId}: No Transaction Made`
              : `Transaction Cancelled for ${row.transactionId}: No Transaction Made`,
        });
      });
    },
    /** Paytm local cancel preconditions (terminal_helpers.py:566-583). */
    async paytmCancelFacts(row: ActiveTransaction, orderId: string) {
      return transact(async (tx) => {
        const [completed] = await tx
          .select({ id: PosPaytmTransaction.id })
          .from(PosPaytmTransaction)
          .where(
            and(
              eq(PosPaytmTransaction.order_id, BigInt(orderId)),
              eq(PosPaytmTransaction.platform, 'txn_completed'),
            ),
          )
          .limit(1);
        const [machine] = await tx
          .select()
          .from(PosPaytmMachine)
          .where(
            and(
              eq(PosPaytmMachine.store_id, Number(row.storeId)),
              eq(PosPaytmMachine.paytm_mid, row.mid),
            ),
          )
          .orderBy(asc(PosPaytmMachine.id))
          .limit(1);
        return {
          completed: Boolean(completed),
          mid: machine?.paytm_mid ?? 'no mid',
          tid: machine?.paytm_tid ?? 'no tid',
          terminal: machine ? paytmTerminal(machine) : null,
        };
      });
    },
    /** `AjaxPaymentStatusView.post` (order/views.py:685-775), one Drizzle transaction. */
    async paymentStatus(
      user: Principal,
      storeId: string,
      orderId: string,
      input: PaymentStatusInput,
    ) {
      return transact(async (tx) => {
        requireStore(user, storeId);
        requireRole(user, [1, 2, 3]);
        await assertCurrentStoreAccess(tx, user.id, storeId);
        const record = await mapping(tx, storeId, orderId);
        const paid = input.payType === 1;
        if (
          paid &&
          !decimalOf(input.offlinePayment)
            .plus(input.onlinePayment)
            .equals(decimalOf(record.payable))
        )
          throw new AppError(422, 'PAYMENT_TOTAL_MISMATCH', 'Incorrect Pay amount.');
        let lineStatus = 'PLACED';
        if (paid) {
          const name = await deliveredStatusName(tx, BigInt(input.orderStatus));
          if (name === null)
            throw new AppError(422, 'ORDER_STATUS_NOT_FOUND', 'Select a valid order status.');
          lineStatus = name;
          const [paymentStatus] = await tx
            .select({ id: PaymentStatus.id })
            .from(PaymentStatus)
            .where(eq(PaymentStatus.id, BigInt(input.paymentStatus)))
            .limit(1);
          if (!paymentStatus)
            throw new AppError(422, 'PAYMENT_STATUS_NOT_FOUND', 'Select a valid payment status.');
        }
        const finalPayment = paid ? BigInt(input.paymentStatus) : 1n,
          finalOrder = paid ? BigInt(input.orderStatus) : 1n,
          offline = Number(input.offlinePayment),
          online = Number(input.onlinePayment),
          timestamp = now();
        await tx
          .update(OrderStore)
          .set({
            is_manually_paid: paid,
            transaction_id: input.transactionId ?? '',
            message: input.message,
            offline_payment: input.offlinePayment,
            online_payment: input.onlinePayment,
          })
          .where(eq(OrderStore.order, BigInt(orderId)));
        await tx
          .update(Order)
          .set({ payment_statuses: finalPayment, order_statuses: finalOrder })
          .where(eq(Order.id, BigInt(orderId)));
        await tx.insert(Comments).values({
          order_id: BigInt(orderId),
          status_id: finalOrder,
          comment: paid
            ? `Store Order: ${lineStatus} status changed by pos admin.`
            : 'Store Order: Status Reverted to PLACED by pos admin.',
          notify: 0,
          user_id: BigInt(user.id),
          package_details: '',
          created_at: timestamp,
          updated_at: timestamp,
          has_product_id: 0n,
          prod_id: 0n,
        });
        if (!paid)
          await tx
            .delete(Comments)
            .where(and(eq(Comments.order_id, BigInt(orderId)), eq(Comments.status_id, 3n)));
        await tx
          .update(HasProduct)
          .set({ status: storedEnumValue(hasProductStatuses, lineStatus) })
          .where(eq(HasProduct.order, BigInt(orderId)));
        const [first] = await tx
          .select({ store: OrderStore.store })
          .from(OrderStore)
          .where(eq(OrderStore.order, BigInt(orderId)))
          .orderBy(asc(OrderStore.id))
          .limit(1);
        const sourceStore = String(first?.store ?? storeId);
        await markStale(
          tx,
          sourceStore,
          orderId,
          record.createdAt,
          paid ? 'MANUAL_PAID' : 'PAYMENT_REVERSED',
        );
        await transactionLog(tx, {
          orderId,
          storeId: sourceStore,
          userId: user.id,
          payDict: paid
            ? legacyPayDict([
                ['cash payment', offline],
                ['online payment', online],
                ['total amount on counter', offline + online],
              ])
            : '{}',
          comment: paid
            ? `Order Delivered : Total Amount Recieved at Counter : ${pythonFloat(offline + online)}`
            : 'Store Order: Status Reverted to PLACED by pos admin. Recieved Amount Return to customer on Counter (Only counter amount)',
          statuses: { order: finalOrder, payment: finalPayment },
        });
        return { paid };
      });
    },
  };
}
export type PaymentRepository = ReturnType<typeof paymentRepository>;

/**
 * Compatible reader for pending-order cancellation (cancellations/repository.ts).
 * Attempts now live only in the provider tables: `completed` = any `txn_completed`
 * row, `candidates` = active `txn_created` rows. `hashSecret` is ignored.
 */
export async function readOrderPaymentEvidence(
  tx: PaymentTransaction,
  orderId: string,
  _hashSecret?: string,
) {
  const rows = async (table: typeof PosTerminalTransaction | typeof PosPaytmTransaction) =>
    tx
      .select({
        id: table.id,
        platform: table.platform,
        active: table.is_active,
        transactionId: table.transaction_id,
      })
      .from(table)
      .where(
        and(
          eq(table.order_id, BigInt(orderId)),
          inArray(table.platform, ['txn_created', 'txn_completed']),
        ),
      )
      .limit(201)
      .for('update');
  const records = [
    ...(await rows(PosTerminalTransaction)).map((row) => ({ ...row, provider: 'pine' as const })),
    ...(await rows(PosPaytmTransaction)).map((row) => ({ ...row, provider: 'paytm' as const })),
  ];
  const candidates = records
    .filter((row) => row.platform === 'txn_created' && row.active)
    .map((row) => ({ ...row, id: String(row.id) }));
  return {
    attempts: [] as { status: string; cashAmount: string; cashReceived: string }[],
    records,
    completed: records.some((row) => row.platform === 'txn_completed'),
    candidates,
    ambiguous: candidates.length > 1,
  };
}
