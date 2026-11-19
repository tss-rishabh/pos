import { Decimal } from 'decimal.js';
import { inArray, type SQL } from 'drizzle-orm';
import { AppError } from '../domain/errors.js';
import type { PaymentCorrectionCashDetails } from './checkout/payment-reversals/cash-projection.js';
import type { Rollup } from './daily-report.js';
/** Only source cash/count/residual change. Native line/revenue/benefit predicates stay intact. */
export function paymentCorrectionDailyStoreTemplate(source: string) {
  const changes: ReadonlyArray<readonly [string, string]> = [
    [
      'COUNT(*) AS order_count,',
      'SUM(CASE WHEN ord.payment_correction_managed = 1 THEN 0 ELSE 1 END) AS order_count,',
    ],
    [
      'SUM(ord.cash) AS cash_total,',
      'SUM(CASE WHEN ord.payment_correction_managed = 1 THEN 0 ELSE ord.cash END) AS cash_total,',
    ],
    [
      'MAX(t.CASH) AS cash,',
      'MAX(t.CASH) AS cash, MAX(t.PaymentCorrectionManaged) AS payment_correction_managed,',
    ],
    [
      'oss.offline_payment AS CASH,',
      'oss.offline_payment AS CASH, CASE WHEN __PAYMENT_CORRECTION_MATCH__ THEN 1 ELSE 0 END AS PaymentCorrectionManaged,',
    ],
    [
      'SUM(ord.pay_amount - ord.cash - ord.district) AS total_online',
      'SUM(CASE WHEN ord.payment_correction_managed = 1 THEN 0 ELSE ord.pay_amount - ord.cash - ord.district END) AS total_online',
    ],
  ];
  let result = source;
  for (const [before, after] of changes) {
    if (result.split(before).length !== 2)
      throw new AppError(
        500,
        'DAILY_REPORT_DEFINITION_CHANGED',
        'The payment cash report definition requires review.',
      );
    result = result.replace(before, after);
  }
  return result;
}
/** Only the already verified, bounded source order IDs enter this native predicate.
 * This avoids cross-collation string joins and one correlated lookup per HP row. */
export function matchedPaymentCorrectionOrder(
  orderId: SQL,
  verifiedOrderIds: readonly string[],
): SQL {
  if (verifiedOrderIds.length > 1000)
    throw new AppError(
      503,
      'PAYMENT_CORRECTION_EVIDENCE_INVALID',
      'A payment cash partition requires reconciliation.',
    );
  // An empty list renders `false`, exactly as before.
  return inArray(orderId, verifiedOrderIds.map(BigInt));
}
export function addDailyPaymentCorrections(
  source: readonly Rollup[],
  corrections: readonly PaymentCorrectionCashDetails[],
  stores: readonly DailyStore[],
): Rollup[] {
  const rows = source.map((row) => ({ ...row })),
    byDay = new Map(rows.map((row) => [`${row.store_id}\0${row.order_date}`, row])),
    dimensions = new Map(stores.map((row) => [row.id, row]));
  for (const correction of corrections) {
    const key = `${correction.storeId}\0${correction.date}`;
    let row = byDay.get(key);
    if (!row) {
      const store = dimensions.get(correction.storeId);
      if (!store)
        throw new AppError(
          503,
          'DAILY_REPORT_STORE_RECONCILIATION_REQUIRED',
          'A cash movement store dimension requires reconciliation.',
        );
      row = emptyDailyStoreRow(store, correction.date);
      rows.push(row);
      byDay.set(key, row);
    }
    row.cash_total = new Decimal(row.cash_total).plus(correction.cashIn).toNumber();
    row.order_count += correction.logicalOrderCount;
    row.payment_correction_cash_out = new Decimal(row.payment_correction_cash_out || 0)
      .plus(correction.cashOut)
      .toNumber();
    if (
      !Number.isSafeInteger(row.order_count) ||
      row.order_count < 0 ||
      !Number.isSafeInteger(new Decimal(row.cash_total).mul(100).toNumber()) ||
      !Number.isSafeInteger(new Decimal(row.payment_correction_cash_out).mul(100).toNumber())
    )
      throw new AppError(
        503,
        'DAILY_REPORT_AMOUNT_RECONCILIATION_REQUIRED',
        'A payment cash total requires reconciliation.',
      );
  }
  return rows;
}

export function applyDailyPaymentCorrectionPartitions(
  source: readonly Rollup[],
  baselineHashes: ReadonlyMap<string, string>,
  partitions: ReadonlyMap<
    string,
    import('./finance/payment-correction-publication.js').PaymentCorrectionPartition
  >,
): Rollup[] {
  const rows = source.map((row) => ({ ...row })),
    byDay = new Map(rows.map((row) => [`${row.store_id}\0${row.order_date}`, row]));
  for (const [key, partition] of partitions) {
    if (partition.kind !== 'daily')
      throw new AppError(
        503,
        'PAYMENT_CORRECTION_PUBLICATION_INVALID',
        'A payment report partition is invalid.',
      );
    const delta = partition.payload,
      baseline = byDay.get(key),
      hash = baselineHashes.get(key) ?? null;
    if (
      hash !== delta.baselineHash ||
      (!baseline &&
        (delta.sourceCashRemoval !== '0.00' ||
          delta.sourceOnlineRemoval !== '0.00' ||
          delta.sourceOrderCountRemoval !== 0)) ||
      delta.sourceOrderCountRemoval > (baseline?.order_count ?? 0)
    )
      throw new AppError(
        503,
        'PAYMENT_CORRECTION_PUBLICATION_INVALID',
        'The source payment report partition changed.',
      );
    const row =
      baseline ??
      emptyDailyStoreRow(
        { id: partition.storeId, name: delta.storeName, locationCode: delta.locationCode },
        partition.businessDate,
      );
    row.cash_total = new Decimal(row.cash_total)
      .minus(delta.sourceCashRemoval)
      .plus(delta.cashIn)
      .toNumber();
    row.total_online = new Decimal(row.total_online).minus(delta.sourceOnlineRemoval).toNumber();
    row.order_count = row.order_count - delta.sourceOrderCountRemoval + delta.logicalOrderCount;
    row.payment_correction_cash_out = Number(delta.cashOut);
    if (
      !Number.isSafeInteger(row.order_count) ||
      row.order_count < 0 ||
      new Decimal(row.cash_total).lt(0) ||
      !Number.isSafeInteger(new Decimal(row.cash_total).mul(100).toNumber()) ||
      !Number.isFinite(row.total_online)
    )
      throw new AppError(
        503,
        'PAYMENT_CORRECTION_PUBLICATION_INVALID',
        'The published payment report amount is invalid.',
      );
    if (
      !baseline &&
      (delta.cashIn !== '0.00' || delta.cashOut !== '0.00' || delta.logicalOrderCount !== 0)
    ) {
      rows.push(row);
      byDay.set(key, row);
    }
  }
  return rows;
}

export interface DailyStore {
  id: string;
  name: string;
  locationCode: string;
}
export function emptyDailyStoreRow(store: DailyStore, date: string): Rollup {
  const id = Number(store.id);
  if (!Number.isSafeInteger(id))
    throw new AppError(
      503,
      'DAILY_REPORT_STORE_RECONCILIATION_REQUIRED',
      'A cash movement store dimension requires reconciliation.',
    );
  return {
    store_id: id,
    store_name: store.name,
    location_code: store.locationCode,
    order_date: date,
    order_count: 0,
    qty: 0,
    revenue: 0,
    membership_purchase_orders: 0,
    membership_orders_total: 0,
    membership_revenue: 0,
    tss_money_used_total: 0,
    tss_points_used_total: 0,
    pg_discount_total: 0,
    gift_voucher_total: 0,
    district_total: 0,
    cash_total: 0,
    total_online: 0,
  };
}
