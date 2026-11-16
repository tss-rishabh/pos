import { Decimal } from 'decimal.js';
import { and, asc, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import { GiftCardCollection, HasProduct, MUser, Order } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { globalVoucherHistory, globalVouchers } from '../../global-vouchers/legacy-schema.js';
import { activeCheckoutCustomer } from '../customer-access.js';
import {
  applyCancellationMembership,
  lockCancellationMembership,
  type LockedCancellationMembership,
} from './membership.js';
import {
  giftCardIssuances,
  giftCardIssuanceContract,
  giftCardIssuanceHashSql,
} from '../gift-card-issuance.js';
import { assertCancellationVoucherIndex } from './voucher-history.js';
import { operationHash } from '../crypto.js';
import { cashRefundAudit } from '../offline-cash/source-ledger.js';
import { identifier } from '../../../domain/validation.js';
import { checkoutHeaderHashSql } from '../projection.js';
import {
  planCancellationBenefitCandidate,
  type CancellationEarningAllocation,
} from './benefit-candidate.js';
import {
  cancellationMoneyAllocations,
  cancellationPointAllocations,
  cancellationMoneyHistory,
  cancellationPointHistory,
} from './benefit-schema.js';
import {
  cancellationBenefitPolicy,
  cancellationBenefitSummarySchema,
  type CancellationBenefitLine,
  type CancellationBenefitProfile,
  type CancellationBenefitScope,
  type CancellationBenefitSummary,
} from './benefit-contracts.js';

const review = (code = 'CANCELLATION_BENEFIT_EVIDENCE_INVALID') =>
  new AppError(409, code, 'Original benefit evidence requires reconciliation before cancellation.');
const finite = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;
const textNumber = (column: SQLWrapper) => sql<number>`CAST(${column} AS CHAR)`.mapWith(Number);
const precise = (value: number) => new Decimal(value).toFixed();
type Asset = 'money' | 'points';
type WalletPlan = {
  asset: Asset;
  rows: CancellationEarningAllocation[];
  lines: {
    line: CancellationBenefitLine;
    plan: ReturnType<typeof planCancellationBenefitCandidate>;
  }[];
};
type VoucherPlan = {
  id: bigint;
  before: number;
  after: number;
  amount: number;
  available: boolean;
  status: number;
};
export interface LockedCancellationBenefits {
  readonly fingerprint: string;
  readonly summary: CancellationBenefitSummary;
}
interface Effects {
  tx: AdministrationTransaction;
  scope: CancellationBenefitScope;
  wallets: WalletPlan[];
  voucher: VoucherPlan | null;
  membership: LockedCancellationMembership | null;
  used: boolean;
}
const effects = new WeakMap<LockedCancellationBenefits, Effects>();

/** All reads are current/locking. The caller retains order/store authorization and the same TX. */
export async function lockCancellationBenefits(
  tx: AdministrationTransaction,
  scope: CancellationBenefitScope,
  profile: CancellationBenefitProfile,
  secret: string,
): Promise<LockedCancellationBenefits> {
  if (
    profile.policy !== cancellationBenefitPolicy ||
    profile.walletWriterContract !== 'pos-wallet-user-lock-v1' ||
    profile.voucherWriterContract !== 'pos-voucher-user-lock-v1'
  )
    throw new AppError(
      503,
      'CANCELLATION_BENEFIT_CONTRACT_UNVERIFIED',
      'The source benefit restoration contracts must be verified.',
    );
  for (const id of [
    scope.orderId,
    scope.customerId,
    ...scope.lines.flatMap((line) => [line.lineId, line.productId]),
  ])
    identifier.parse(id);
  if (
    !scope.lines.length ||
    scope.lines.length > 1000 ||
    new Set(scope.lines.map((line) => line.lineId)).size !== scope.lines.length
  )
    throw review();
  Temporal.PlainDateTime.from(scope.timestamp.replace(' ', 'T'));
  const [order] = await tx
    .select({
      id: Order.id,
      customerId: Order.user,
      voucherId: Order.voucher_used,
      money: textNumber(Order.tss_money_used),
      points: textNumber(Order.tss_points_used),
      voucher: textNumber(Order.voucher_amt_used),
      method: Order.payment_methods,
      status: Order.order_statuses,
      payment: Order.payment_statuses,
      hash: sql<string>`${sql.raw(checkoutHeaderHashSql)}`,
    })
    .from(Order)
    .where(eq(Order.id, BigInt(scope.orderId)))
    .for('update');
  if (
    !order ||
    String(order.customerId) !== scope.customerId ||
    order.method !== 14n ||
    order.status !== 1n ||
    order.payment !== 1n ||
    order.hash !== scope.headerHash ||
    order.money !== scope.money ||
    order.points !== scope.points ||
    (order.voucher ?? 0) !== scope.voucher ||
    String(order.voucherId) !== scope.voucherId
  )
    throw review();
  const sourceLines = await tx
    .select({
      id: HasProduct.id,
      productId: HasProduct.product,
      status: HasProduct.status,
      refunded: HasProduct.cashback_refunded,
      auditId: cashRefundAudit.id,
      money: textNumber(cashRefundAudit.money),
      points: textNumber(cashRefundAudit.points),
      voucher: textNumber(cashRefundAudit.voucher),
      isRefunded: cashRefundAudit.isRefunded,
      auditRefunded: cashRefundAudit.refunded,
    })
    .from(HasProduct)
    .leftJoin(
      cashRefundAudit,
      and(
        eq(cashRefundAudit.lineId, HasProduct.id),
        eq(cashRefundAudit.productId, HasProduct.product),
        eq(cashRefundAudit.orderId, HasProduct.order),
      ),
    )
    .where(eq(HasProduct.order, order.id))
    .orderBy(asc(HasProduct.id))
    .limit(1001)
    .for('update');
  const supplied = new Map(scope.lines.map((line) => [line.lineId, line]));
  if (
    sourceLines.length !== supplied.size ||
    new Set(sourceLines.map((line) => String(line.id))).size !== supplied.size ||
    sourceLines.some((line) => {
      const expected = supplied.get(String(line.id));
      return (
        !expected ||
        !line.auditId ||
        line.status !== 'PLACED' ||
        (line.refunded ?? 0) !== 0 ||
        (line.isRefunded ?? 0) !== 0 ||
        line.auditRefunded !== 0 ||
        String(line.productId) !== expected.productId ||
        line.money !== expected.money ||
        line.points !== expected.points ||
        line.voucher !== expected.voucher
      );
    })
  )
    throw review('CANCELLATION_BENEFIT_TOTAL_MISMATCH');
  const [customer] = await tx
    .select({
      id: MUser.id,
      active: MUser.status,
      blocked: MUser.is_block,
      disabled: MUser.is_disabled,
      money: textNumber(MUser.tss_money),
      points: textNumber(MUser.tss_points),
      cashback: textNumber(MUser.cashback),
    })
    .from(MUser)
    .where(eq(MUser.id, order.customerId))
    .for('update');
  if (
    !customer ||
    !activeCheckoutCustomer(customer) ||
    ![customer.money, customer.points, customer.cashback].every(finite)
  )
    throw review();
  const summary: CancellationBenefitSummary = {
    policy: cancellationBenefitPolicy,
    moneyCredited: '0',
    moneyExpired: '0',
    pointsCredited: '0',
    pointsExpired: '0',
    voucherCredited: '0',
    voucherAvailable: null,
    membership: 'unchanged',
  };
  const wallets: WalletPlan[] = [];
  for (const asset of ['money', 'points'] as const) {
    const requested = scope[asset],
      total = scope.lines.reduce((sum, line) => sum.plus(line[asset]), new Decimal(0));
    if (
      !finite(requested) ||
      scope.lines.some((line) => !finite(line[asset])) ||
      !total.eq(requested)
    )
      throw review('CANCELLATION_BENEFIT_TOTAL_MISMATCH');
    if (requested === 0) continue;
    const allocations =
      asset === 'money' ? cancellationMoneyAllocations : cancellationPointAllocations;
    const history = asset === 'money' ? cancellationMoneyHistory : cancellationPointHistory;
    const mappings = await tx
      .select({
        id: allocations.id,
        historyId: allocations.historyId,
        used: allocations.used,
        returned: allocations.returned,
      })
      .from(allocations)
      .where(eq(allocations.orderId, order.id))
      .orderBy(asc(allocations.id))
      .limit(1001)
      .for('update');
    if (
      !mappings.length ||
      mappings.length > 1000 ||
      mappings.some(
        (row) =>
          row.id < 1n ||
          row.historyId < 1n ||
          !finite(row.used) ||
          !finite(row.returned) ||
          row.returned > row.used,
      )
    )
      throw review('CANCELLATION_EARNING_TRACE_INCOMPLETE');
    const ids = [...new Set(mappings.map((row) => row.historyId))];
    const histories = await tx
      .select({
        id: history.id,
        userId: history.userId,
        added: history.added,
        used: history.used,
        expiry: history.expiry,
        expired: history.expired,
        platform: history.platform,
      })
      .from(history)
      .where(inArray(history.id, ids))
      .orderBy(asc(history.id))
      .for('update');
    const indexed = new Map(histories.map((row) => [row.id, row]));
    if (
      histories.length !== ids.length ||
      histories.some(
        (row) =>
          row.userId !== order.customerId ||
          !finite(row.added) ||
          !finite(row.used) ||
          row.used > row.added ||
          ![0, 1].includes(row.expired ?? -1),
      )
    )
      throw review('CANCELLATION_EARNING_TRACE_INCOMPLETE');
    const assigned = new Map<bigint, Decimal>();
    for (const mapping of mappings)
      assigned.set(
        mapping.historyId,
        (assigned.get(mapping.historyId) ?? new Decimal(0)).plus(mapping.used),
      );
    const rows: CancellationEarningAllocation[] = mappings.map((mapping) => {
      const earning = indexed.get(mapping.historyId)!;
      if (assigned.get(earning.id)!.gt(earning.used))
        throw review('CANCELLATION_EARNING_TRACE_INCOMPLETE');
      return {
        mappingId: String(mapping.id),
        historyId: String(mapping.historyId),
        used: mapping.used,
        returned: mapping.returned!,
        expiry: earning.expiry === '0000-00-00 00:00:00' ? null : earning.expiry,
        expired: earning.expired === 1,
        bonus: asset === 'money' && earning.platform === 'FIRST_ORDER_RETURN_BONUS',
      };
    });
    const lines: WalletPlan['lines'] = [];
    for (const line of scope.lines) {
      if (line[asset] === 0) continue;
      const plan = planCancellationBenefitCandidate(
        line[asset],
        rows,
        scope.timestamp.slice(0, 10),
      );
      for (const allocation of plan.allocations)
        rows.find((row) => row.mappingId === allocation.mappingId)!.returned =
          allocation.returnedAfter;
      lines.push({ line, plan });
    }
    const credited = lines.reduce(
        (sum, row) => row.plan.credits.reduce((result, credit) => result.plus(credit.amount), sum),
        new Decimal(0),
      ),
      expired = lines.reduce((sum, row) => sum.plus(row.plan.expiredAmount), new Decimal(0));
    summary[asset === 'money' ? 'moneyCredited' : 'pointsCredited'] = credited.toFixed();
    summary[asset === 'money' ? 'moneyExpired' : 'pointsExpired'] = expired.toFixed();
    wallets.push({ asset, rows, lines });
  }
  let voucher: VoucherPlan | null = null;
  const voucherTotal = scope.lines.reduce((sum, line) => sum.plus(line.voucher), new Decimal(0));
  if (
    !finite(scope.voucher) ||
    scope.lines.some((line) => !finite(line.voucher)) ||
    !voucherTotal.eq(scope.voucher)
  )
    throw review('CANCELLATION_BENEFIT_TOTAL_MISMATCH');
  if (scope.voucher > 0) {
    if (BigInt(scope.voucherId) < 1n) throw review();
    const [hint] = await tx
      .select({ kind: globalVouchers.kind, collectionId: globalVouchers.collectionId })
      .from(globalVouchers)
      .where(eq(globalVouchers.id, BigInt(scope.voucherId)))
      .limit(1);
    if (!hint || !['GIFT_CARD', 'GIFT_VOUCHER'].includes(hint.kind)) throw review();
    let blocked = false;
    if (hint.kind === 'GIFT_CARD') {
      const [collection] = await tx
        .select({ id: GiftCardCollection.id, blocked: GiftCardCollection.is_block })
        .from(GiftCardCollection)
        .where(eq(GiftCardCollection.id, hint.collectionId))
        .for('update');
      if (!collection || ![0, 1].includes(collection.blocked)) throw review();
      blocked = collection.blocked === 1;
    }
    const [row] = await tx
      .select({
        id: globalVouchers.id,
        kind: globalVouchers.kind,
        collectionId: globalVouchers.collectionId,
        issuerId: globalVouchers.customerId,
        fundingOrderId: globalVouchers.orderId,
        serial: globalVouchers.serial,
        fundingHash: sql<string>`${sql.raw(giftCardIssuanceHashSql)}`,
        value: globalVouchers.value,
        initial: globalVouchers.initialValue,
        status: globalVouchers.status,
        startsAt: globalVouchers.startsAt,
        expiresAt: globalVouchers.expiresAt,
      })
      .from(globalVouchers)
      .where(eq(globalVouchers.id, BigInt(scope.voucherId)))
      .for('update');
    if (
      !row ||
      row.kind !== hint.kind ||
      row.collectionId !== hint.collectionId ||
      !finite(row.value) ||
      !finite(row.initial) ||
      ![0, 1].includes(row.status)
    )
      throw review();
    if (row.kind === 'GIFT_CARD') {
      if (row.fundingOrderId < 1n || row.serial < 1n || row.collectionId < 1n || row.issuerId < 1n)
        throw review('CANCELLATION_GIFT_CARD_FUNDING_UNCONFIRMED');
      const [funding] = await tx
        .select()
        .from(giftCardIssuances)
        .where(eq(giftCardIssuances.voucherId, row.id))
        .for('share');
      if (
        !funding ||
        funding.contract !== giftCardIssuanceContract ||
        funding.orderId !== row.fundingOrderId ||
        funding.collectionId !== row.collectionId ||
        funding.serial !== row.serial ||
        funding.inputHash !== row.fundingHash
      )
        throw review('CANCELLATION_GIFT_CARD_FUNDING_UNCONFIRMED');
    }
    await assertCancellationVoucherIndex(tx);
    const entries = await tx
      .select({
        userId: globalVoucherHistory.userId,
        amount: globalVoucherHistory.amount,
        before: globalVoucherHistory.before,
        after: globalVoucherHistory.after,
        platform: globalVoucherHistory.platform,
      })
      .from(globalVoucherHistory)
      .where(
        and(eq(globalVoucherHistory.orderId, order.id), eq(globalVoucherHistory.voucherId, row.id)),
      )
      .orderBy(asc(globalVoucherHistory.id))
      .limit(1001)
      .for('update');
    const debits = entries.filter((entry) => entry.platform === 'ORDER_PLACED');
    if (
      entries.length > 1000 ||
      debits.length !== 1 ||
      entries.some((entry) =>
        ['ORDER_CANCELLED', 'ORDER_REFUND', 'PRODUCT_RETURN', 'ORDER_RETURN'].includes(
          entry.platform || '',
        ),
      )
    )
      throw review('CANCELLATION_VOUCHER_DEBIT_UNCONFIRMED');
    const debit = debits[0]!;
    if (
      debit.userId !== order.customerId ||
      debit.amount === null ||
      !Number.isFinite(debit.amount) ||
      !new Decimal(debit.amount).eq(voucherTotal.negated()) ||
      !finite(debit.before) ||
      !finite(debit.after) ||
      !new Decimal(debit.before).minus(debit.after).eq(voucherTotal)
    )
      throw review('CANCELLATION_VOUCHER_DEBIT_UNCONFIRMED');
    const after = row.value + scope.voucher;
    if (!Number.isFinite(after) || new Decimal(after).gt(row.initial)) throw review();
    let valid = true;
    if (row.kind === 'GIFT_CARD') {
      try {
        const day = Temporal.PlainDate.from(scope.timestamp.slice(0, 10));
        valid =
          row.startsAt !== null &&
          row.expiresAt !== null &&
          Temporal.PlainDate.compare(
            day,
            Temporal.PlainDateTime.from(row.startsAt.replace(' ', 'T')).toPlainDate(),
          ) >= 0 &&
          Temporal.PlainDate.compare(
            day,
            Temporal.PlainDateTime.from(row.expiresAt.replace(' ', 'T')).toPlainDate(),
          ) <= 0;
      } catch {
        valid = false;
      }
    }
    // A disabled status is not proof of exhaustion: retain the credit without
    // reactivating a later administrative disable, conversion or expired card.
    voucher = {
      id: row.id,
      before: row.value,
      after,
      amount: scope.voucher,
      status: row.status,
      available: row.status === 1 && !blocked && valid,
    };
    summary.voucherCredited = precise(scope.voucher);
    summary.voucherAvailable = voucher.available;
  }
  const membership = scope.membership ? await lockCancellationMembership(tx, scope, profile) : null;
  if (membership) summary.membership = membership.outcome;
  const checked = cancellationBenefitSummarySchema.parse(summary),
    fingerprint = operationHash(
      'pending-cancellation.benefits.v1',
      {
        customer: { ...customer, id: String(customer.id) },
        wallets,
        voucher: voucher ? { ...voucher, id: String(voucher.id) } : null,
        membership: membership?.fingerprint ?? null,
        headerHash: scope.headerHash,
        timestampDate: scope.timestamp.slice(0, 10),
      },
      secret,
    );
  const result = Object.freeze({ fingerprint, summary: Object.freeze(checked) });
  effects.set(result, { tx, scope, wallets, voucher, membership, used: false });
  return result;
}

/** Must run in the exact writer transaction that holds the plan's financial locks. */
export async function applyCancellationBenefits(
  tx: AdministrationTransaction,
  plan: LockedCancellationBenefits,
): Promise<void> {
  const state = effects.get(plan);
  if (!state || state.tx !== tx || state.used) throw review('CANCELLATION_BENEFIT_PLAN_CHANGED');
  state.used = true;
  const { scope } = state;
  for (const wallet of state.wallets) {
    const allocations =
      wallet.asset === 'money' ? cancellationMoneyAllocations : cancellationPointAllocations;
    for (const row of wallet.rows)
      await tx
        .update(allocations)
        .set({ returned: row.returned, updatedAt: scope.timestamp })
        .where(eq(allocations.id, BigInt(row.mappingId)));
    for (const entry of wallet.lines) {
      const sourceRows = new Map(wallet.rows.map((row) => [row.mappingId, row]));
      let pointsBefore: number | null = null,
        pointCredit = 0;
      for (const credit of [
        ...entry.plan.allocations
          .filter((allocation) => allocation.expired)
          .map((allocation) => ({
            amount: -allocation.amount,
            expiry: sourceRows.get(allocation.mappingId)!.expiry,
            bonus: false,
          })),
        ...entry.plan.credits,
      ]) {
        const field = wallet.asset === 'money' ? MUser.tss_money : MUser.tss_points;
        const [balance] = await tx
          .select({ value: textNumber(field) })
          .from(MUser)
          .where(eq(MUser.id, BigInt(scope.customerId)))
          .for('update');
        if (!balance || !finite(balance.value)) throw review();
        if (wallet.asset === 'points' && pointsBefore === null) pointsBefore = balance.value;
        const expired = credit.amount < 0;
        const before = wallet.asset === 'points' ? pointsBefore! + pointCredit : balance.value;
        if (!expired && wallet.asset === 'points') pointCredit += credit.amount;
        const after = expired
          ? before
          : wallet.asset === 'points'
            ? pointsBefore! + pointCredit
            : before + credit.amount;
        if (!Number.isFinite(after) || after < 0) throw review();
        const common = {
          userId: BigInt(scope.customerId),
          orderId: BigInt(scope.orderId),
          productId: BigInt(entry.line.productId),
          lineId: BigInt(entry.line.lineId),
          added: credit.amount,
          used: 0,
          before,
          after,
          platform: expired
            ? wallet.asset === 'money'
              ? 'TSS_MONEY_EXPIRED'
              : 'TSS_POINTS_EXPIRED'
            : credit.bonus
              ? 'FIRST_ORDER_RETURN_BONUS'
              : 'ORDER_CANCELLED',
          comment: expired
            ? 'Cancellation: original benefit already expired'
            : wallet.asset === 'money'
              ? 'TSS Money Reverted For Order Cancellation'
              : 'TSS Points Reverted For Order Cancellation',
          operatorId: 0n,
          expiry: credit.expiry,
          expired: expired ? 1 : 0,
          bulk: 0,
          createdAt: scope.timestamp,
          updatedAt: scope.timestamp,
        };
        if (wallet.asset === 'money') await tx.insert(cancellationMoneyHistory).values(common);
        else await tx.insert(cancellationPointHistory).values({ ...common, gameId: 0n });
        if (!expired && wallet.asset === 'money')
          await tx
            .update(MUser)
            .set({ tss_money: sql`${MUser.tss_money} + ${credit.amount}` })
            .where(eq(MUser.id, BigInt(scope.customerId)));
      }
      // The original Points helper publishes one native FLOAT update per HP;
      // expiry-split history must not introduce additional balance rounding.
      if (wallet.asset === 'points' && pointCredit > 0)
        await tx
          .update(MUser)
          .set({ tss_points: sql`${MUser.tss_points} + ${pointCredit}` })
          .where(eq(MUser.id, BigInt(scope.customerId)));
    }
  }
  if (state.membership) await applyCancellationMembership(tx, state.membership);
  if (state.voucher) {
    const voucher = state.voucher;
    await tx
      .update(globalVouchers)
      .set({ value: voucher.after, updatedAt: scope.timestamp })
      .where(eq(globalVouchers.id, voucher.id));
    await tx.insert(globalVoucherHistory).values({
      userId: BigInt(scope.customerId),
      orderId: BigInt(scope.orderId),
      voucherId: voucher.id,
      amount: voucher.amount,
      before: voucher.before,
      after: voucher.after,
      platform: 'ORDER_CANCELLED',
      comment: 'Gift Voucher Reverted For Order Cancellation',
      operatorId: 0n,
      bulk: 0,
      createdAt: scope.timestamp,
      updatedAt: scope.timestamp,
    });
  }
}
