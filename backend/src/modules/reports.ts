import { Temporal } from '@js-temporal/polyfill';
import { and, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Databases } from '../db/pools.js';
import { Store, StoreDayBanking } from '../db/legacy-schema.js';
import { scopedStores, type Principal } from '../domain/access.js';
import { AppError } from '../domain/errors.js';
import { routeRead, type ReportRange } from '../domain/routing.js';
import { legacyReportSql } from './legacy-report-sql.js';
import { mergeDailyRows, dailyTotals, type Rollup } from './daily-report.js';
import { warehouseService } from './warehouse.js';
import { checkInService } from './administration/checkins.js';
import { parseStoreRollout, storeRolloutEnabled } from '../domain/rollout.js';
import { aggregateOfflineCash, matchedImportedOfflineOrder } from './finance/offline-cash.js';
import { addDailyOfflineCash, offlineDailyStoreTemplate } from './daily-report-offline.js';
import type { DailyWarehouseOptions, DailyWarehousePublication } from './daily-report-warehouse.js';
import {
  matchedPaymentCorrectionOrder,
  paymentCorrectionDailyStoreTemplate,
  addDailyPaymentCorrections,
  applyDailyPaymentCorrectionPartitions,
} from './daily-report-corrections.js';
import { readPaymentCorrectionCash } from './checkout/payment-reversals/cash-projection.js';
import {
  paymentCorrectionFinanceOptions,
  type PaymentCorrectionFinanceOptions,
} from './finance/payment-corrections.js';
import {
  assertSameCashReturnHeads,
  cashReturnPartitionHeads,
} from './checkout/payment-reversals/intent-guards.js';
import type { CashReturnControl } from './checkout/payment-reversals/intent-contracts.js';
import { readPaymentCorrectionPartitions } from './finance/payment-correction-publication.js';
import type { DailyWarehouseQuery } from './daily-report-warehouse.js';
import { identifier } from '../domain/validation.js';

const number = z.coerce.number().finite();
export const rollupSchema = z.object({
  store_id: z.coerce.number().int().safe(),
  store_name: z.string(),
  location_code: z.string(),
  order_date: z.string(),
  order_count: number,
  qty: number,
  revenue: number,
  membership_purchase_orders: number,
  membership_orders_total: number,
  membership_revenue: number,
  tss_money_used_total: number,
  tss_points_used_total: number,
  pg_discount_total: number,
  gift_voucher_total: number,
  district_total: number,
  cash_total: number,
  total_online: number,
});
export interface DailyReportInput {
  storeIds: string[];
  from: string;
  to: string;
}
export async function assertDailyReportingEnabled(config: Config, db: Databases, user: Principal) {
  if (user.role === 1 || parseStoreRollout(config.DAY_CLOSE_ENABLED_STORE_IDS).all) return;
  const checkedInStore = await checkInService(db, config).checkedInStore(user.id);
  if (
    !(await storeRolloutEnabled(
      () => db.get('writer'),
      config.DAY_CLOSE_ENABLED_STORE_IDS,
      user.role,
      checkedInStore || '0',
    ))
  )
    throw new AppError(
      403,
      'FEATURE_NOT_ENABLED',
      'Daily reporting is not enabled for your checked-in store.',
    );
}
export function dailyReportRange(input: DailyReportInput, zone: string): ReportRange {
  try {
    const start = Temporal.PlainDate.from(input.from).toZonedDateTime({
      timeZone: zone,
      plainTime: '00:00',
    });
    const end = Temporal.PlainDate.from(input.to)
      .add({ days: 1 })
      .toZonedDateTime({ timeZone: zone, plainTime: '00:00' });
    if (
      Temporal.ZonedDateTime.compare(end, start) <= 0 ||
      end.since(start, { largestUnit: 'days' }).days > 63
    )
      throw new Error('Invalid range');
    return { start: start.toInstant().toString(), end: end.toInstant().toString() };
  } catch {
    throw new AppError(400, 'INVALID_DATE_RANGE', 'Select a valid date range within 62 days.');
  }
}
export function bindReportSql(
  template: string,
  storeIds: string[],
  exclusions: bigint[],
  start: string,
  end: string,
  offlineMatch?: SQL,
  correctionMatch?: SQL,
): SQL {
  let dateIndex = 0;
  const dates = [start, end];
  const parts = template
    .split(/(__STORES__|__EXCLUDED_PRODUCTS__|__OFFLINE_MATCH__|__PAYMENT_CORRECTION_MATCH__|%s)/)
    .map((part) => {
      if (part === '__PAYMENT_CORRECTION_MATCH__') {
        if (!correctionMatch)
          throw new AppError(
            500,
            'DAILY_REPORT_DEFINITION_CHANGED',
            'The payment cash proof definition requires review.',
          );
        return correctionMatch;
      }
      if (part === '__OFFLINE_MATCH__') {
        if (!offlineMatch)
          throw new AppError(
            500,
            'DAILY_REPORT_DEFINITION_CHANGED',
            'The daily cash proof definition requires review.',
          );
        return offlineMatch;
      }
      if (part === '__STORES__')
        return sql.join(
          storeIds.map((id) => sql`${BigInt(id)}`),
          sql`, `,
        );
      if (part === '__EXCLUDED_PRODUCTS__')
        return sql.join(
          (exclusions.length ? exclusions : [0n]).map((id) => sql`${id}`),
          sql`, `,
        );
      if (part === '%s') return sql`${dates[dateIndex++]}`;
      return sql.raw(part);
    });
  if (dateIndex !== 2) throw new Error('Report template parameter count changed');
  return sql.join(parts, sql``);
}
interface DailyReportDependencies {
  warehouse?: Pick<ReturnType<typeof warehouseService>, 'dailyRollups' | 'auxiliary'>;
  warehouseOptions?: DailyWarehouseOptions;
  clock?: () => Temporal.Instant;
  paymentCorrections?: PaymentCorrectionFinanceOptions;
  paymentCorrectionQuery?: DailyWarehouseQuery;
  cashReturnHeads?: (
    storeIds: readonly string[],
    from: string,
    to: string,
  ) => Promise<ReadonlyMap<string, CashReturnControl>>;
}
export function reportService(
  config: Config,
  db: Databases,
  dependencies: DailyReportDependencies = {},
) {
  const corrections = dependencies.paymentCorrections ?? paymentCorrectionFinanceOptions();
  const clock = dependencies.clock || (() => Temporal.Now.instant()),
    warehouse =
      dependencies.warehouse || warehouseService(config, dependencies.warehouseOptions, clock);
  return {
    async daily(user: Principal, value: DailyReportInput) {
      const input = z
        .object({
          storeIds: z.array(identifier).min(1).max(500),
          from: z.iso.date(),
          to: z.iso.date(),
        })
        .strict()
        .parse(value);
      const storeIds = scopedStores(user, input.storeIds),
        range = dailyReportRange(input, config.BUSINESS_TIMEZONE);
      await assertDailyReportingEnabled(config, db, user);
      const readHeads = () =>
        dependencies.cashReturnHeads?.(storeIds, input.from, input.to) ??
        cashReturnPartitionHeads(
          db.get('writer'),
          storeIds,
          input.from,
          input.to,
          'daily',
          corrections.proofKey ?? '',
        );
      const heads = await readHeads();
      const reader = routeRead({ kind: 'report', range }, clock(), config.BUSINESS_TIMEZONE);
      let storeRows: Rollup[],
        onlineRows: Rollup[],
        banking: Record<string, number> = {},
        publication: DailyWarehousePublication | undefined,
        auxiliary: { footfall: Record<string, number>; target: Record<string, number> } = {
          footfall: {},
          target: {},
        };
      if (reader === 'bigquery') {
        const result = await warehouse.dailyRollups(storeIds, input.from, input.to);
        publication = result.publication;
        const pending = z.union([
          z.number().int().safe().nonnegative(),
          z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger),
        ]);
        const publicationRows = z
          .array(
            rollupSchema.extend({
              order_source: z.enum(['store_orders', 'online_orders']),
              banking_amount: number.nullable(),
              footfall: number.nullable(),
              target: number.nullable(),
              pending_offline_orders: pending,
            }),
          )
          .safeParse(result.rows);
        if (!publicationRows.success)
          throw new AppError(
            503,
            'DAILY_WAREHOUSE_PUBLICATION_INVALID',
            'A daily report publication has invalid financial fields.',
          );
        const parsed = publicationRows.data;
        if (!publication.sourcePosition)
          throw new AppError(
            503,
            'PAYMENT_CORRECTION_PUBLICATION_INVALID',
            'The payment report publication has no common source position.',
          );
        const paymentPublication = await readPaymentCorrectionPartitions(
          {
            table: corrections.publicationTable,
            proofKey: corrections.proofKey,
            controlHeads: heads,
          },
          dependencies.paymentCorrectionQuery ?? warehouseService(config).queryReport,
          { kind: 'daily', storeIds, from: input.from, to: input.to },
          config.BUSINESS_TIMEZONE,
          clock(),
          publication,
        );
        storeRows = parsed.filter((r) => r.order_source === 'store_orders');
        onlineRows = parsed.filter((r) => r.order_source === 'online_orders');
        const baselineHashes = new Map(
          result.rows
            .filter((row) => row.order_source === 'store_orders')
            .map((row) => [
              `${row.store_id}\0${row.order_date}`,
              z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .parse(row.row_hash),
            ]),
        );
        storeRows = applyDailyPaymentCorrectionPartitions(
          storeRows,
          baselineHashes,
          paymentPublication.partitions,
        );
        const auxByPartition = new Map<string, string>();
        for (const row of parsed) {
          if (
            !Number.isSafeInteger(row.order_count) ||
            row.order_count < 0 ||
            row.pending_offline_orders > row.order_count
          )
            throw new AppError(
              503,
              'DAILY_WAREHOUSE_PUBLICATION_INVALID',
              'A daily report publication has inconsistent order counts.',
            );
          if (row.order_source === 'online_orders' && row.pending_offline_orders !== 0)
            throw new AppError(
              503,
              'DAILY_WAREHOUSE_PUBLICATION_INVALID',
              'A daily report publication has inconsistent offline counts.',
            );
          const partition = `${row.store_id}\0${row.order_date}`,
            fingerprint = JSON.stringify([
              row.store_name,
              row.location_code,
              row.banking_amount,
              row.footfall,
              row.target,
            ]),
            previous = auxByPartition.get(partition);
          if (previous !== undefined && previous !== fingerprint)
            throw new AppError(
              503,
              'DAILY_WAREHOUSE_PUBLICATION_INVALID',
              'A daily report publication has inconsistent auxiliary figures.',
            );
          auxByPartition.set(partition, fingerprint);
          if (row.banking_amount !== undefined && row.banking_amount !== null)
            banking[`${row.store_id}\0${row.order_date}`] = row.banking_amount;
          const key = `${row.store_name.trim()}\0${row.order_date}`;
          if (row.footfall !== null) auxiliary.footfall[key] = row.footfall;
          if (row.target !== null) auxiliary.target[key] = row.target;
        }
      } else {
        const database = db.get('data');
        const current = await database.transaction(
          async (transaction) => {
            assertSameCashReturnHeads(
              heads,
              await cashReturnPartitionHeads(
                transaction,
                storeIds,
                input.from,
                input.to,
                'daily',
                corrections.proofKey ?? '',
              ),
            );
            const [excluded] = await transaction.execute(sql.raw(legacyReportSql.excludedProducts));
            const excludedRows = z.array(z.record(z.string(), z.unknown())).parse(excluded);
            const exclusions = excludedRows.map((row) =>
              BigInt(
                z
                  .union([
                    z.string().regex(/^\d{1,20}$/),
                    z.number().int().safe().nonnegative(),
                    z.bigint().nonnegative(),
                  ])
                  .parse(Object.values(row)[0]),
              ),
            );
            const local = (value: string) =>
              Temporal.Instant.from(value)
                .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
                .toPlainDateTime()
                .toString({ smallestUnit: 'second' })
                .replace('T', ' ');
            const start = local(range.start),
              end = local(Temporal.Instant.from(range.end).subtract({ seconds: 1 }).toString());
            const offline = await aggregateOfflineCash(transaction, storeIds, input.from, input.to);
            const paymentCash = await readPaymentCorrectionCash(
              transaction,
              { storeIds, from: input.from, to: input.to },
              corrections.proofKey ?? '',
            );
            const [walkIn, online] = await Promise.all([
              transaction.execute(
                bindReportSql(
                  paymentCorrectionDailyStoreTemplate(
                    offlineDailyStoreTemplate(legacyReportSql.storeOrders),
                  ),
                  storeIds,
                  exclusions,
                  start,
                  end,
                  matchedImportedOfflineOrder(transaction, {
                    orderId: sql.raw('o.id'),
                    storeId: sql.raw('oss.store_id'),
                    counterId: sql.raw('oss.counter_id'),
                  }),
                  matchedPaymentCorrectionOrder(sql.raw('o.id'), paymentCash.managedOrderIds),
                ),
              ),
              transaction.execute(
                bindReportSql(legacyReportSql.onlineOrders, storeIds, exclusions, start, end),
              ),
            ]);
            const storeRows = z.array(rollupSchema).parse(walkIn[0]);
            const onlineRows = z
              .array(rollupSchema)
              .parse(online[0])
              .map((row) => ({ ...row, pending_offline_orders: 0 }));
            const dimensions =
              offline.length || paymentCash.rows.length
                ? await transaction
                    .select({
                      id: Store.id,
                      name: Store.store_name,
                      locationCode: Store.location_code,
                    })
                    .from(Store)
                    .where(inArray(Store.id, storeIds.map(BigInt)))
                : [];
            const augmented = addDailyOfflineCash(
              storeRows,
              offline,
              dimensions.map((store) => ({
                id: String(store.id),
                name: store.name || String(store.id),
                locationCode: store.locationCode || '',
              })),
            );
            const bankRows = await transaction
              .select({
                storeId: StoreDayBanking.store_id,
                date: StoreDayBanking.banking_date,
                amount: StoreDayBanking.amount,
              })
              .from(StoreDayBanking)
              .where(
                and(
                  inArray(StoreDayBanking.store_id, storeIds.map(Number)),
                  gte(StoreDayBanking.banking_date, input.from),
                  lte(StoreDayBanking.banking_date, input.to),
                ),
              );
            return {
              storeRows: addDailyPaymentCorrections(
                augmented,
                paymentCash.rows,
                dimensions.map((store) => ({
                  id: String(store.id),
                  name: store.name || String(store.id),
                  locationCode: store.locationCode || '',
                })),
              ),
              onlineRows,
              banking: Object.fromEntries(
                bankRows.map((row) => [`${row.storeId}\0${row.date}`, Number(row.amount)]),
              ),
            };
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
        storeRows = current.storeRows;
        onlineRows = current.onlineRows;
        banking = current.banking;
        const names = [...storeRows, ...onlineRows].map((row) => row.store_name);
        auxiliary = await warehouse.auxiliary(names, input.from, input.to);
      }
      assertSameCashReturnHeads(heads, await readHeads());
      const data = mergeDailyRows(storeRows, onlineRows, { ...auxiliary, banking });
      const totals = dailyTotals(data);
      return {
        reader,
        range,
        data,
        totals,
        pendingOrderCount: Number(totals.pending_offline_orders || 0),
        ...(publication ? { publication } : {}),
      };
    },
  };
}
