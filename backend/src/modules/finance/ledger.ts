import { Temporal } from '@js-temporal/polyfill';
import { Decimal } from 'decimal.js';
import { and, asc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  AmountToBeRefundedLog,
  Order,
  OrderStore,
  ReturnOrder,
  Store,
  StoreCashOpeningBalance,
  StoreDayBanking,
  StoreDayClose,
} from '../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import { money } from './domain.js';
import {
  aggregateOfflineCash,
  lateOfflineCashForLatestClose,
  matchedImportedOfflineOrder,
} from './offline-cash.js';

const id = z
  .union([z.string().regex(/^\d+$/), z.number().int().refine(Number.isSafeInteger), z.bigint()])
  .transform(String);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDate.from(value).year >= 1000;
    } catch {
      return false;
    }
  }, 'Use a valid calendar date.');
const amount = z
  .union([z.string().regex(/^-?\d+(?:\.\d+)?$/), z.number().finite()])
  .transform((value) => money(value));
const table = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  )
  .optional();
export function ledgerOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BQ_FINANCE_OPENING_BALANCES: table,
      BQ_FINANCE_DAY_CLOSES: table,
      BQ_FINANCE_DAY_BANKING: table,
      BQ_FINANCE_CASH_COLLECTIONS: table,
      BQ_FINANCE_CASH_COLLECTIONS_OFFLINE_CONTRACT: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.literal('pos-offline-cash-ledger-v1').optional(),
      ),
    })
    .parse(env);
}
type LedgerOptions = ReturnType<typeof ledgerOptions>;
const anchorSchema = z.object({ storeId: id, date: day, amount });
const closeSchema = z.object({
  storeId: id,
  date: day,
  version: z.coerce.number().int().min(1),
  status: z.string(),
  cashSystem: amount,
  cashRefund: amount,
  cashPunched: amount,
  cashCreated: amount,
  cashActual: amount,
  cashDifference: amount,
  banking: amount,
});
const bankingSchema = z.object({ storeId: id, date: day, amount });
const salesSchema = z.object({
  storeId: id,
  date: day,
  cash: amount,
  cashRefund: amount,
  lateOfflineCash: amount.optional(),
});
const warehouseSalesSchema = salesSchema.extend({
  lateOfflineCash: amount,
  cashProjectionContract: z.literal('pos-offline-cash-ledger-v1'),
});
export type LedgerAnchor = z.infer<typeof anchorSchema>;
export type LedgerClose = z.infer<typeof closeSchema>;
export type LedgerBanking = z.infer<typeof bankingSchema>;
export type LedgerSales = z.infer<typeof salesSchema>;
export interface LedgerStore {
  id: string;
  name: string;
}
export interface CashLedgerRow {
  store_id: string;
  store_name: string;
  date: string;
  opening_cash: string;
  sales_cash: string | null;
  running_total: string | null;
  actual_cash: string | null;
  difference: string | null;
  banking_amount: string | null;
  closing_balance: string | null;
  status: string;
  note: string;
}
export function ledgerBounds(
  from: string | undefined,
  to: string | undefined,
  now: Temporal.Instant,
  zone: string,
) {
  const today = now.toZonedDateTimeISO(zone).toPlainDate(),
    start = Temporal.PlainDate.from(from || today.with({ day: 1 }).toString()),
    requestedEnd = Temporal.PlainDate.from(to || today.toString()),
    end = Temporal.PlainDate.compare(requestedEnd, today) > 0 ? today : requestedEnd;
  if (Temporal.PlainDate.compare(start, today) > 0)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'The From date cannot be in the future.');
  if (Temporal.PlainDate.compare(end, start) < 0)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'The To date is before the From date.');
  if (end.since(start, { largestUnit: 'days' }).days > 366)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'Pick a range of 366 days or less.');
  return { from: start.toString(), to: end.toString(), today: today.toString() };
}
function startDay(anchors: LedgerAnchor[], from: string) {
  const before = anchors
    .filter((anchor) => anchor.date <= from)
    .map((anchor) => anchor.date)
    .sort();
  return before.at(-1) || anchors.map((anchor) => anchor.date).sort()[0]!;
}
/** Pure source ledger: latest version, anchor resets, open-day stop and banking override. */
export function cashLedgerRows(
  stores: LedgerStore[],
  anchors: LedgerAnchor[],
  closes: LedgerClose[],
  banking: LedgerBanking[],
  sales: LedgerSales[],
  from: string,
  to: string,
): CashLedgerRow[] {
  const latest = new Map<string, LedgerClose>(),
    banks = new Map(banking.map((row) => [`${row.storeId}:${row.date}`, row.amount])),
    live = new Map(sales.map((row) => [`${row.storeId}:${row.date}`, row]));
  for (const close of closes) {
    const key = `${close.storeId}:${close.date}`;
    if (!latest.has(key) || latest.get(key)!.version < close.version) latest.set(key, close);
  }
  const result: CashLedgerRow[] = [];
  for (const store of [...stores].sort((a, b) => a.name.localeCompare(b.name))) {
    const selected = anchors.filter((anchor) => anchor.storeId === store.id && anchor.date <= to),
      byDay = new Map(selected.map((anchor) => [anchor.date, anchor.amount]));
    if (!selected.length) continue;
    let date = startDay(selected, from),
      balance = '0.00';
    while (date <= to) {
      balance = byDay.get(date) || balance;
      const close = latest.get(`${store.id}:${date}`),
        row: CashLedgerRow = {
          store_id: store.id,
          store_name: store.name,
          date,
          opening_cash: balance,
          sales_cash: null,
          running_total: null,
          actual_cash: null,
          difference: null,
          banking_amount: null,
          closing_balance: null,
          status: 'NOT_CLOSED',
          note: '',
        };
      if (close) {
        const cash = new Decimal(close.cashSystem)
            .minus(close.cashRefund)
            .minus(close.cashPunched)
            .plus(close.cashCreated),
          banked = banks.get(`${store.id}:${date}`) ?? close.banking,
          running = new Decimal(balance).plus(cash),
          closing = running.minus(banked);
        Object.assign(row, {
          sales_cash: money(cash),
          running_total: money(running),
          actual_cash: close.cashActual,
          difference: money(new Decimal(close.cashDifference).negated()),
          banking_amount: banked,
          closing_balance: money(closing),
          status: close.status,
        });
        const lateOfflineCash = live.get(`${store.id}:${date}`)?.lateOfflineCash;
        if (close.status === 'STALE' && lateOfflineCash && new Decimal(lateOfflineCash).gt(0))
          row.note = `Accepted offline cash of ${lateOfflineCash} arrived after this close. The displayed close figures are frozen; reconcile and reclose.`;
        if (date >= from) result.push(row);
        balance = money(closing);
        date = Temporal.PlainDate.from(date).add({ days: 1 }).toString();
        continue;
      }
      const next = selected
        .filter((anchor) => anchor.date > date)
        .map((anchor) => anchor.date)
        .sort()[0];
      if (date < from) row.note = 'Ledger stopped here: this day is not closed yet';
      else {
        const snapshot = live.get(`${store.id}:${date}`);
        if (!snapshot)
          throw new AppError(
            503,
            'LEDGER_SNAPSHOT_MISSING',
            'A cash collection snapshot is missing for this ledger day.',
          );
        const cash = new Decimal(snapshot.cash).minus(snapshot.cashRefund);
        row.sales_cash = money(cash);
        row.running_total = money(new Decimal(balance).plus(cash));
      }
      if (next) {
        if (date >= from) result.push(row);
        date = next;
        continue;
      }
      result.push(row);
      break;
    }
  }
  return result;
}
async function currentCash(
  db: Pick<ReturnType<Databases['get']>, 'select' | 'selectDistinct'>,
  storeIds: string[],
  date: string,
): Promise<LedgerSales[]> {
  const start = date + ' 00:00:00',
    end = Temporal.PlainDate.from(date).add({ days: 1 }).toString() + ' 00:00:00';
  const offline = await aggregateOfflineCash(db, storeIds, date, date);
  const lateOffline = await lateOfflineCashForLatestClose(db, storeIds, date, date);
  const collections = await db
    .select({
      storeId: OrderStore.store,
      cash: sql<string>`coalesce(sum(case when ${matchedImportedOfflineOrder(db)} then 0 else ${OrderStore.offline_payment} end),0)`,
    })
    .from(Order)
    .innerJoin(OrderStore, eq(OrderStore.order, Order.id))
    .where(
      and(
        inArray(OrderStore.store, storeIds.map(BigInt)),
        gte(Order.created_at, start),
        lt(Order.created_at, end),
        sql`(${OrderStore.offline_payment}+${OrderStore.online_payment}+${OrderStore.online_other_payment})>0`,
      ),
    )
    .groupBy(OrderStore.store);
  const returned = db
    .selectDistinct({
      storeId: ReturnOrder.store_id,
      orderId: ReturnOrder.order_id,
      hasProductId: ReturnOrder.has_product_id,
    })
    .from(ReturnOrder)
    .where(
      and(
        inArray(ReturnOrder.store_id, storeIds.map(Number)),
        gte(ReturnOrder.created_at, start),
        lt(ReturnOrder.created_at, end),
      ),
    )
    .as('ledger_returned_lines');
  const refunds = await db
    .select({
      storeId: returned.storeId,
      cashRefund: sql<string>`coalesce(sum(${AmountToBeRefundedLog.refunded_amt}),0)`,
    })
    .from(AmountToBeRefundedLog)
    .innerJoin(
      returned,
      and(
        eq(returned.orderId, AmountToBeRefundedLog.order_id),
        eq(returned.hasProductId, AmountToBeRefundedLog.has_product_id),
      ),
    )
    .where(
      and(
        eq(AmountToBeRefundedLog.refund_mode, 'cash'),
        eq(AmountToBeRefundedLog.is_refunded, true),
      ),
    )
    .groupBy(returned.storeId);
  const cash = new Map(collections.map((row) => [String(row.storeId), money(row.cash)])),
    cashRefund = new Map(refunds.map((row) => [String(row.storeId), money(row.cashRefund)]));
  for (const row of offline)
    cash.set(row.storeId, money(new Decimal(cash.get(row.storeId) || '0').plus(row.cash)));
  return storeIds.map((storeId) => ({
    storeId,
    date,
    cash: cash.get(storeId) || '0.00',
    cashRefund: cashRefund.get(storeId) || '0.00',
    lateOfflineCash: lateOffline.find((row) => row.storeId === storeId)?.cash || '0.00',
  }));
}
export function cashLedgerService(
  config: Config,
  db: Databases,
  options: LedgerOptions = ledgerOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  const queryReport = (
    statement: string,
    params: Record<string, unknown>,
    types: Record<string, string | string[]>,
  ) => warehouse.queryReport(statement, params, types, 'cash-ledger');
  return {
    async stores(user: Principal) {
      const rows = await db
        .get('primary')
        .select({ id: Store.id, name: Store.store_name })
        .from(Store)
        .where(
          and(
            eq(Store.is_active, true),
            eq(Store.type, 'STORE'),
            user.role === 1 ? undefined : inArray(Store.id, user.storeIds.map(BigInt)),
          ),
        )
        .orderBy(asc(Store.store_name));
      return {
        data: rows.map((store) => ({ id: String(store.id), name: store.name || String(store.id) })),
      };
    },
    async read(user: Principal, requested: string[] | undefined, from?: string, to?: string) {
      const bounds = ledgerBounds(from, to, clock(), config.BUSINESS_TIMEZONE),
        ids = requested?.length ? [...new Set(requested)] : user.storeIds;
      ids.forEach((storeId) => requireStore(user, storeId));
      const stores = await db
        .get('primary')
        .select({ id: Store.id, name: Store.store_name })
        .from(Store)
        .where(
          and(
            eq(Store.is_active, true),
            eq(Store.type, 'STORE'),
            user.role === 1 && !requested?.length ? undefined : inArray(Store.id, ids.map(BigInt)),
          ),
        )
        .orderBy(asc(Store.store_name))
        .limit(501);
      if (stores.length > 500)
        throw new AppError(422, 'REPORT_TOO_LARGE', 'Select at most 500 stores.');
      if (
        stores.length *
          (Temporal.PlainDate.from(bounds.to).since(Temporal.PlainDate.from(bounds.from), {
            largestUnit: 'days',
          }).days +
            1) >
        70000
      )
        throw new AppError(422, 'REPORT_TOO_LARGE', 'Select fewer stores or a shorter date range.');
      const storeIds = stores.map((store) => String(store.id)),
        storeDtos = stores.map((store) => ({
          id: String(store.id),
          name: store.name || String(store.id),
        }));
      if (!storeIds.length) return { reader: 'data' as const, range: bounds, data: [] };
      let anchors: LedgerAnchor[] = [],
        closes: LedgerClose[] = [],
        banking: LedgerBanking[] = [],
        sales: LedgerSales[] = [],
        reader: 'data' | 'bigquery' = 'bigquery';
      if (bounds.from === bounds.today && bounds.to === bounds.today) {
        anchors = z.array(anchorSchema).parse(
          await db
            .get('data')
            .select({
              storeId: StoreCashOpeningBalance.store_id,
              date: StoreCashOpeningBalance.balance_date,
              amount: StoreCashOpeningBalance.amount,
            })
            .from(StoreCashOpeningBalance)
            .where(
              and(
                inArray(StoreCashOpeningBalance.store_id, storeIds.map(Number)),
                eq(StoreCashOpeningBalance.balance_date, bounds.today),
              ),
            ),
        );
        // Any missing anchor requires the historical chain. Never reconstruct it
        // by reading older MySQL rows behind a nominally current-day report.
        if (storeIds.every((storeId) => anchors.some((anchor) => anchor.storeId === storeId)))
          reader = 'data';
      }
      if (reader === 'bigquery') {
        if (!options.BQ_FINANCE_CASH_COLLECTIONS_OFFLINE_CONTRACT)
          return unavailable('BigQuery offline cash collection contract');
        const tableName = (
          name: Exclude<keyof LedgerOptions, 'BQ_FINANCE_CASH_COLLECTIONS_OFFLINE_CONTRACT'>,
        ) => {
          const value = options[name];
          if (!value)
            return unavailable(`BigQuery ${name.replace('BQ_FINANCE_', '').toLowerCase()} table`);
          return '`' + value + '`';
        };
        const params = { stores: storeIds, end: bounds.to },
          types = { stores: ['STRING'], end: 'DATE' };
        anchors = z
          .array(anchorSchema)
          .parse(
            await queryReport(
              `SELECT CAST(store_id AS STRING) AS storeId,CAST(balance_date AS STRING) AS date,CAST(amount AS STRING) AS amount FROM ${tableName('BQ_FINANCE_OPENING_BALANCES')} WHERE CAST(store_id AS STRING) IN UNNEST(@stores) AND balance_date<=@end`,
              params,
              types,
            ),
          );
        const starts = storeIds.flatMap((storeId) => {
          const rows = anchors.filter((anchor) => anchor.storeId === storeId);
          return rows.length ? [startDay(rows, bounds.from)] : [];
        });
        if (!starts.length) return { reader, range: bounds, data: [] };
        const start = starts.sort()[0]!,
          chainParams = { ...params, start },
          chainTypes = { ...types, start: 'DATE' };
        const [closeRows, bankingRows, salesRows] = await Promise.all([
          queryReport(
            `SELECT CAST(store_id AS STRING) AS storeId,CAST(close_date AS STRING) AS date,version,status,CAST(cash_system AS STRING) AS cashSystem,CAST(cash_refund_system AS STRING) AS cashRefund,CAST(cash_manual_punched AS STRING) AS cashPunched,CAST(cash_manual_created AS STRING) AS cashCreated,CAST(cash_actual AS STRING) AS cashActual,CAST(cash_difference AS STRING) AS cashDifference,CAST(banking_amount AS STRING) AS banking FROM ${tableName('BQ_FINANCE_DAY_CLOSES')} WHERE CAST(store_id AS STRING) IN UNNEST(@stores) AND close_date BETWEEN @start AND @end QUALIFY ROW_NUMBER() OVER(PARTITION BY store_id,close_date ORDER BY version DESC)=1`,
            chainParams,
            chainTypes,
          ),
          queryReport(
            `SELECT CAST(store_id AS STRING) AS storeId,CAST(banking_date AS STRING) AS date,CAST(amount AS STRING) AS amount FROM ${tableName('BQ_FINANCE_DAY_BANKING')} WHERE CAST(store_id AS STRING) IN UNNEST(@stores) AND banking_date BETWEEN @start AND @end`,
            chainParams,
            chainTypes,
          ),
          queryReport(
            `SELECT CAST(store_id AS STRING) AS storeId,CAST(business_date AS STRING) AS date,CAST(cash AS STRING) AS cash,CAST(cash_refund AS STRING) AS cashRefund,CAST(late_offline_cash AS STRING) AS lateOfflineCash,offline_cash_projection_contract AS cashProjectionContract FROM ${tableName('BQ_FINANCE_CASH_COLLECTIONS')} WHERE CAST(store_id AS STRING) IN UNNEST(@stores) AND business_date BETWEEN @start AND @end`,
            { ...params, start: bounds.from },
            { ...types, start: 'DATE' },
          ),
        ]);
        closes = z.array(closeSchema).parse(closeRows);
        banking = z.array(bankingSchema).parse(bankingRows);
        const rows = z.array(warehouseSalesSchema).parse(salesRows);
        // Sparse rollups represent zero sales, while an unconfigured view fails above.
        const byDay = new Map(rows.map((row) => [`${row.storeId}:${row.date}`, row]));
        for (const storeId of storeIds)
          for (
            let date = bounds.from;
            date <= bounds.to;
            date = Temporal.PlainDate.from(date).add({ days: 1 }).toString()
          )
            sales.push(
              byDay.get(`${storeId}:${date}`) || {
                storeId,
                date,
                cash: '0.00',
                cashRefund: '0.00',
              },
            );
      } else {
        const database = db.get('data'),
          condition = and(
            inArray(StoreDayClose.store_id, storeIds.map(Number)),
            gte(StoreDayClose.close_date, bounds.from),
            lte(StoreDayClose.close_date, bounds.to),
          );
        closes = z.array(closeSchema).parse(
          await database
            .select({
              storeId: StoreDayClose.store_id,
              date: StoreDayClose.close_date,
              version: StoreDayClose.version,
              status: StoreDayClose.status,
              cashSystem: StoreDayClose.cash_system,
              cashRefund: StoreDayClose.cash_refund_system,
              cashPunched: StoreDayClose.cash_manual_punched,
              cashCreated: StoreDayClose.cash_manual_created,
              cashActual: StoreDayClose.cash_actual,
              cashDifference: StoreDayClose.cash_difference,
              banking: StoreDayClose.banking_amount,
            })
            .from(StoreDayClose)
            .where(condition),
        );
        banking = z.array(bankingSchema).parse(
          await database
            .select({
              storeId: StoreDayBanking.store_id,
              date: StoreDayBanking.banking_date,
              amount: StoreDayBanking.amount,
            })
            .from(StoreDayBanking)
            .where(
              and(
                inArray(StoreDayBanking.store_id, storeIds.map(Number)),
                gte(StoreDayBanking.banking_date, bounds.from),
                lte(StoreDayBanking.banking_date, bounds.to),
              ),
            ),
        );
        sales = await database.transaction(
          (transaction) => currentCash(transaction, storeIds, bounds.today),
          {
            isolationLevel: 'repeatable read',
            accessMode: 'read only',
          },
        );
      }
      return {
        reader,
        range: bounds,
        data: cashLedgerRows(storeDtos, anchors, closes, banking, sales, bounds.from, bounds.to),
      };
    },
  };
}
