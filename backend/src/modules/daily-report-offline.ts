import { Decimal } from 'decimal.js';
import { AppError } from '../domain/errors.js';
import type { Rollup } from './daily-report.js';
import type { OfflineCashAggregate } from './finance/offline-cash.js';

/** Keep every source HP predicate and financial residual; change only cash/count. */
export function offlineDailyStoreTemplate(source: string) {
  const changes: ReadonlyArray<readonly [string, string]> = [
    [
      'COUNT(*) AS order_count,',
      'SUM(CASE WHEN ord.offline_cash_imported = 1 THEN 0 ELSE 1 END) AS order_count,',
    ],
    [
      'SUM(ord.cash) AS cash_total,',
      'SUM(CASE WHEN ord.offline_cash_imported = 1 THEN 0 ELSE ord.cash END) AS cash_total,',
    ],
    [
      'MAX(t.CASH) AS cash,',
      'MAX(t.CASH) AS cash, MAX(t.OfflineCashImported) AS offline_cash_imported,',
    ],
    [
      'oss.offline_payment AS CASH,',
      'oss.offline_payment AS CASH, CASE WHEN __OFFLINE_MATCH__ THEN 1 ELSE 0 END AS OfflineCashImported,',
    ],
  ];
  let result = source;
  for (const [before, after] of changes) {
    if (result.split(before).length !== 2)
      throw new AppError(
        500,
        'DAILY_REPORT_DEFINITION_CHANGED',
        'The daily report source definition requires review.',
      );
    result = result.replace(before, after);
  }
  return result;
}
export interface OfflineDailyStore {
  id: string;
  name: string;
  locationCode: string;
}
export function addDailyOfflineCash(
  source: readonly Rollup[],
  offline: readonly OfflineCashAggregate[],
  stores: readonly OfflineDailyStore[],
): Rollup[] {
  const rows = source.map((row) => ({ ...row, pending_offline_orders: 0 })),
    byDay = new Map(rows.map((row) => [`${row.store_id}\0${row.order_date}`, row])),
    dimensions = new Map(stores.map((store) => [store.id, store]));
  for (const cash of offline) {
    const key = `${cash.storeId}\0${cash.date}`;
    let row = byDay.get(key);
    if (!row) {
      const store = dimensions.get(cash.storeId),
        id = Number(cash.storeId);
      if (!store || !Number.isSafeInteger(id))
        throw new AppError(
          503,
          'DAILY_REPORT_STORE_RECONCILIATION_REQUIRED',
          'A cash receipt store dimension requires reconciliation.',
        );
      row = {
        store_id: id,
        store_name: store.name,
        location_code: store.locationCode,
        order_date: cash.date,
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
        pending_offline_orders: 0,
      };
      rows.push(row);
      byDay.set(key, row);
    }
    row.cash_total = new Decimal(row.cash_total).plus(cash.cash).toNumber();
    row.order_count += cash.orderCount;
    row.pending_offline_orders += cash.pendingOrderCount;
    if (
      !Number.isFinite(row.cash_total) ||
      !Number.isSafeInteger(row.order_count) ||
      !Number.isSafeInteger(row.pending_offline_orders)
    )
      throw new AppError(
        503,
        'DAILY_REPORT_AMOUNT_RECONCILIATION_REQUIRED',
        'A daily cash total requires reconciliation.',
      );
  }
  return rows;
}
