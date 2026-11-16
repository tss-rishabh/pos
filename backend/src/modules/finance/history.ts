import { Temporal } from '@js-temporal/polyfill';
import { Decimal } from 'decimal.js';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  like,
  lte,
  max,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store, StoreDayClose } from '../../db/legacy-schema.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import { closeWindow, money } from './domain.js';
import { ledgerOptions } from './ledger.js';

const id = z
    .union([z.string().regex(/^\d+$/), z.number().int().refine(Number.isSafeInteger), z.bigint()])
    .transform(String),
  amount = z
    .union([z.string().regex(/^-?\d+(?:\.\d+)?$/), z.number().finite()])
    .transform((value) => money(value));
const datetime = z.string().transform((value) => value.replace('T', ' ').slice(0, 19));
const closeSchema = z.object({
  id,
  store_id: id,
  close_date: z.string(),
  version: z.coerce.number().int(),
  status: z.string(),
  closed_by_id: id,
  closed_at: datetime,
  cash_system: amount,
  cash_refund_system: amount,
  cash_actual: amount,
  cash_manual_punched: amount,
  cash_manual_created: amount,
  cash_difference: amount,
  cash_reason: z.string(),
  cash_comment: z.string(),
  card_system: amount,
  card_actual: amount,
  card_manual_punched: amount,
  card_manual_created: amount,
  card_difference: amount,
  card_reason: z.string(),
  card_comment: z.string(),
  district_system: amount,
  banking_amount: amount,
  stale_reason: z.string().nullable(),
  last_verified_at: datetime.nullable(),
});
type Close = z.infer<typeof closeSchema>;
export interface HistoryInput {
  storeIds?: string[];
  from: string;
  to: string;
  attempts: 'all' | 'latest';
  search?: string;
  page: number;
  pageSize: number;
}
const searched = [
  'status',
  'cash_comment',
  'card_comment',
  'cash_reason',
  'card_reason',
  'stale_reason',
] as const;
export function differenceResult(value: string, tolerance: string): 'TALLIED' | 'SHORT' | 'EXCESS' {
  const amount = new Decimal(value);
  return amount.abs().lte(tolerance) ? 'TALLIED' : amount.gt(0) ? 'SHORT' : 'EXCESS';
}
function closedLate(close: Close, config: Config): 'Yes' | 'No' {
  const time = Temporal.PlainDateTime.from(close.closed_at.replace(' ', 'T'))
      .toZonedDateTime(config.BUSINESS_TIMEZONE)
      .toInstant(),
    window = closeWindow(close.close_date, config);
  return Temporal.Instant.compare(time, window.opensAt.toInstant()) >= 0 &&
    Temporal.Instant.compare(time, window.closesAt.toInstant()) <= 0
    ? 'No'
    : 'Yes';
}
export function historyRows(
  rows: Close[],
  stores: Map<string, string>,
  operators: Map<string, string>,
  config: Config,
) {
  return rows.map((row) => ({
    ...row,
    store_name: stores.get(row.store_id) || row.store_id,
    closed_by: operators.get(row.closed_by_id) || row.closed_by_id,
    closed_late: closedLate(row, config),
    cash_result: differenceResult(row.cash_difference, config.DAY_CLOSE_TOLERANCE),
    card_result: differenceResult(row.card_difference, config.DAY_CLOSE_TOLERANCE),
  }));
}
export function closeHistoryService(
  config: Config,
  db: Databases,
  options: ReturnType<typeof ledgerOptions> = ledgerOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async read(user: Principal, input: HistoryInput, all = false) {
      const from = Temporal.PlainDate.from(input.from),
        to = Temporal.PlainDate.from(input.to),
        span = to.since(from, { largestUnit: 'days' }).days;
      if (span < 0 || span > 366)
        throw new AppError(400, 'INVALID_DATE_RANGE', 'Select a valid range of 366 days or less.');
      const ids = input.storeIds?.length
        ? [...new Set(input.storeIds)]
        : user.role === 1
          ? undefined
          : user.storeIds;
      ids?.forEach((id) => requireStore(user, id));
      const today = clock().toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate().toString(),
        reader =
          input.from === today && input.to === today ? ('data' as const) : ('bigquery' as const);
      if (ids?.length === 0) return { reader, data: [], total: 0, page: 1, totalPages: 0 };
      const limit = all ? 70001 : input.pageSize;
      let rows: Close[], total: number, page: number, totalPages: number;
      if (reader === 'bigquery') {
        if (!options.BQ_FINANCE_DAY_CLOSES) return unavailable('BigQuery day-close history table');
        const table = '`' + options.BQ_FINANCE_DAY_CLOSES + '`',
          search = input.search || '',
          params = {
            stores: ids || [],
            allStores: ids === undefined,
            start: input.from,
            end: input.to,
            latest: input.attempts === 'latest',
            search,
          },
          types = {
            stores: ['STRING'],
            allStores: 'BOOL',
            start: 'DATE',
            end: 'DATE',
            latest: 'BOOL',
            search: 'STRING',
          };
        const cte = `WITH scoped AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY store_id,close_date ORDER BY version DESC) AS latest_rank FROM ${table} WHERE (@allStores OR CAST(store_id AS STRING) IN UNNEST(@stores)) AND close_date BETWEEN @start AND @end), filtered AS (SELECT * FROM scoped WHERE (NOT @latest OR latest_rank=1) AND (@search='' OR ${searched.map((field) => `STRPOS(LOWER(COALESCE(${field},'')),LOWER(@search))>0`).join(' OR ')}))`;
        const count = await warehouse.queryReport(
          `${cte} SELECT COUNT(*) AS count FROM filtered`,
          params,
          types,
          'day-close-history',
        );
        total = z.coerce.number().int().nonnegative().parse(count[0]?.count);
        totalPages = Math.ceil(total / input.pageSize);
        page = input.page > totalPages ? 1 : input.page;
        const data = await warehouse.queryReport(
          `${cte} SELECT * EXCEPT(latest_rank) FROM filtered ORDER BY close_date DESC,store_id ASC,version DESC LIMIT @limit OFFSET @offset`,
          { ...params, limit, offset: all ? 0 : (page - 1) * input.pageSize },
          { ...types, limit: 'INT64', offset: 'INT64' },
          'day-close-history',
        );
        rows = z.array(closeSchema).parse(data);
      } else {
        const database = db.get('data'),
          latest = alias(StoreDayClose, 'history_latest'),
          pattern = `%${(input.search || '').replace(/[\\%_]/g, '\\$&')}%`;
        const newest = database
          .select({ version: max(latest.version) })
          .from(latest)
          .where(
            and(
              eq(latest.store_id, StoreDayClose.store_id),
              eq(latest.close_date, StoreDayClose.close_date),
            ),
          );
        const condition = and(
          ids ? inArray(StoreDayClose.store_id, ids.map(Number)) : undefined,
          gte(StoreDayClose.close_date, input.from),
          lte(StoreDayClose.close_date, input.to),
          input.attempts === 'latest' ? eq(StoreDayClose.version, newest) : undefined,
          input.search
            ? or(...searched.map((field) => like(StoreDayClose[field], pattern)))
            : undefined,
        );
        const [count] = await database
          .select({ count: sql<number>`count(*)` })
          .from(StoreDayClose)
          .where(condition);
        total = Number(count?.count || 0);
        totalPages = Math.ceil(total / input.pageSize);
        page = input.page > totalPages ? 1 : input.page;
        rows = z.array(closeSchema).parse(
          await database
            .select(getTableColumns(StoreDayClose))
            .from(StoreDayClose)
            .where(condition)
            .orderBy(
              desc(StoreDayClose.close_date),
              asc(StoreDayClose.store_id),
              desc(StoreDayClose.version),
            )
            .limit(limit)
            .offset(all ? 0 : (page - 1) * input.pageSize),
        );
      }
      if (all && rows.length > 70000)
        throw new AppError(
          422,
          'REPORT_TOO_LARGE',
          'Select a smaller store/date range for export.',
        );
      if (!rows.length) return { reader, data: [], total, page, totalPages };
      const storeIds = [...new Set(rows.map((row) => row.store_id))],
        operatorIds = [...new Set(rows.map((row) => row.closed_by_id))],
        primary = db.get('primary');
      const [stores, operators] = await Promise.all([
        storeIds.length
          ? primary
              .select({ id: Store.id, name: Store.store_name })
              .from(Store)
              .where(inArray(Store.id, storeIds.map(BigInt)))
          : [],
        operatorIds.length
          ? primary
              .select({ id: PosUser.id, name: PosUser.username })
              .from(PosUser)
              .where(inArray(PosUser.id, operatorIds.map(BigInt)))
          : [],
      ]);
      const data = historyRows(
        rows,
        new Map(stores.map((store) => [String(store.id), store.name || String(store.id)])),
        new Map(operators.map((operator) => [String(operator.id), operator.name])),
        config,
      );
      return { reader, data, total, page, totalPages };
    },
  };
}
export const historyHeaders = [
  ['store_name', 'Store'],
  ['close_date', 'Date'],
  ['version', 'Attempt'],
  ['status', 'Status'],
  ['stale_reason', 'Invalidated by'],
  ['cash_system', 'Cash (system)'],
  ['cash_refund_system', 'Cash refund'],
  ['cash_actual', 'Cash (actual)'],
  ['cash_manual_punched', 'Cash manual punched'],
  ['cash_manual_created', 'Cash manual created'],
  ['cash_difference', 'Cash difference'],
  ['cash_result', 'Cash result'],
  ['cash_reason', 'Cash reason'],
  ['cash_comment', 'Cash comment'],
  ['card_system', 'Online (system)'],
  ['card_actual', 'Online (actual)'],
  ['card_manual_punched', 'Online manual punched'],
  ['card_manual_created', 'Online manual created'],
  ['card_difference', 'Online difference'],
  ['card_result', 'Online result'],
  ['card_reason', 'Online reason'],
  ['card_comment', 'Online comment'],
  ['district_system', 'District'],
  ['banking_amount', 'Banking'],
  ['closed_by', 'Closed by'],
  ['closed_at', 'Closed at'],
  ['closed_late', 'Closed late'],
  ['last_verified_at', 'Last verified'],
] as const;
export function dayCloseCsv(rows: ReturnType<typeof historyRows>): string {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[\p{C}\p{Z}\s]*[=+\-@\t\r]/u.test(text) && !/^[-+]?\d+(?:\.\d+)?$/.test(text))
      text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return (
    '\uFEFF' +
    [
      historyHeaders.map(([, label]) => label),
      ...rows.map((row) =>
        historyHeaders.map(([field]) =>
          field === 'closed_at' || field === 'last_verified_at'
            ? row[field]?.slice(0, 16) || ''
            : row[field],
        ),
      ),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n')
  );
}
