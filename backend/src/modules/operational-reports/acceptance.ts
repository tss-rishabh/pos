import { Temporal } from '@js-temporal/polyfill';
import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { HyperlocalOrderLog, Order, PosUser, Store } from '../../db/legacy-schema.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { identifier } from '../../domain/validation.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import {
  businessTimestamp,
  scalarId,
  timestampReportBounds,
  warehouseView,
  staffReportScope,
  warehouseReportCount,
} from './report-inputs.js';
export const acceptanceInputSchema = z
  .object({
    from: businessTimestamp,
    to: businessTimestamp,
    storeIds: z.array(identifier).max(500).default([]),
    sort: z
      .enum(['created_at', 'order_id', 'store_name', 'staff_id', 'time_taken'])
      .default('created_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    page: z.number().int().min(1).max(1000000).default(1),
    pageSize: z.number().int().min(1).max(500).default(25),
  })
  .strict();
export type AcceptanceInput = z.infer<typeof acceptanceInputSchema>;
export function acceptanceOptions(env: NodeJS.ProcessEnv = process.env) {
  return z.object({ BQ_HYPERLOCAL_ACCEPTANCE_VIEW: warehouseView }).parse(env);
}
const rawSchema = z.object({
  id: scalarId,
  orderId: scalarId,
  staffId: scalarId,
  storeId: scalarId.nullable(),
  storeName: z.string().nullable(),
  createdAt: z.string().transform((value) => value.replace('T', ' ').slice(0, 19)),
  timeTaken: z.string(),
});
export type AcceptanceRecord = z.infer<typeof rawSchema>;
export function acceptanceRows(rows: AcceptanceRecord[], operators: Map<string, string>) {
  return rows.map((row) => {
    const date = Temporal.PlainDateTime.from(row.createdAt.replace(' ', 'T'));
    return {
      id: row.id,
      order_id: row.orderId,
      storeId: row.storeId,
      store_name: row.storeName,
      staff_name: operators.get(row.staffId) ?? 0,
      time_taken: row.timeTaken,
      created_at: `${String(date.month).padStart(2, '0')}/${String(date.day).padStart(2, '0')}/${date.year} ${String(date.hour % 12 || 12).padStart(2, '0')}:${String(date.minute).padStart(2, '0')} ${date.hour < 12 ? 'AM' : 'PM'}`,
    };
  });
}
const elapsed = sql<number>`timestampdiff(second,${HyperlocalOrderLog.created_at},${HyperlocalOrderLog.updated_at})`,
  timeTaken = sql<string>`concat(case when floor(${elapsed}/86400)>0 then concat(floor(${elapsed}/86400),'D ') else '' end,floor((${elapsed}%86400)/3600),'H ',floor((${elapsed}%3600)/60),'M ',(${elapsed}%60),'S')`;
export function acceptanceReportService(
  config: Config,
  db: Databases,
  options: ReturnType<typeof acceptanceOptions> = acceptanceOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async read(user: Principal, value: AcceptanceInput, all = false) {
      requireRole(user, [1]);
      const input = acceptanceInputSchema.parse(value),
        bounds = timestampReportBounds(config, input.from, input.to, clock()),
        scope = staffReportScope(user, input.storeIds),
        ids = scope.ids;
      ids.forEach((id) => requireStore(user, id));
      if (scope.empty) return { reader: bounds.reader, data: [], total: 0, page: 1, totalPages: 0 };
      let total: number, page: number, totalPages: number, rows: AcceptanceRecord[];
      const limit = all ? 70001 : input.pageSize;
      if (bounds.reader === 'bigquery') {
        if (!options.BQ_HYPERLOCAL_ACCEPTANCE_VIEW)
          return unavailable('BigQuery hyperlocal acceptance view');
        const view = '`' + options.BQ_HYPERLOCAL_ACCEPTANCE_VIEW + '`',
          params = { start: bounds.from, end: bounds.to, stores: ids, allStores: !ids.length },
          types = { start: 'DATETIME', end: 'DATETIME', stores: ['STRING'], allStores: 'BOOL' },
          where =
            'created_at>=@start AND created_at<=@end AND (@allStores OR CAST(store_id AS STRING) IN UNNEST(@stores))';
        const counted = await warehouse.queryReport(
          `SELECT COUNT(*) AS count FROM ${view} WHERE ${where}`,
          params,
          types,
          'hyperlocal-acceptance',
        );
        total = warehouseReportCount(counted);
        totalPages = Math.ceil(total / input.pageSize);
        page = !all && input.page <= totalPages ? input.page : 1;
        if (all && total > 70000)
          throw new AppError(
            422,
            'EXPORT_TOO_LARGE',
            'Select a smaller store/date range for export.',
          );
        const sort = {
          created_at: 'created_at',
          order_id: 'order_id',
          store_name: 'store_name',
          staff_id: 'pos_admin_id',
          time_taken: 'time_taken',
        }[input.sort];
        const result = await warehouse.queryReport(
          `SELECT log_id AS id,order_id AS orderId,pos_admin_id AS staffId,store_id AS storeId,store_name AS storeName,created_at AS createdAt,time_taken AS timeTaken FROM ${view} WHERE ${where} ORDER BY ${sort} ${input.direction},log_id ASC LIMIT @limit OFFSET @offset`,
          { ...params, limit, offset: (page - 1) * input.pageSize },
          { ...types, limit: 'INT64', offset: 'INT64' },
          'hyperlocal-acceptance',
        );
        rows = z.array(rawSchema).parse(result);
      } else {
        const reader = db.get('data'),
          where = and(
            eq(HyperlocalOrderLog.action, 'accepted'),
            gte(HyperlocalOrderLog.created_at, bounds.from),
            lte(HyperlocalOrderLog.created_at, bounds.to),
            ids.length
              ? inArray(
                  Order.location_id,
                  sql`(${sql.join(
                    ids.map((id) => sql`${id}`),
                    sql`,`,
                  )})`,
                )
              : undefined,
          );
        const [counted] = await reader
          .select({ count: count() })
          .from(HyperlocalOrderLog)
          .leftJoin(Order, eq(Order.id, sql`${HyperlocalOrderLog.order_id}`))
          .where(where);
        total = counted?.count || 0;
        totalPages = Math.ceil(total / input.pageSize);
        page = !all && input.page <= totalPages ? input.page : 1;
        if (all && total > 70000)
          throw new AppError(
            422,
            'EXPORT_TOO_LARGE',
            'Select a smaller store/date range for export.',
          );
        const sort = {
          created_at: HyperlocalOrderLog.created_at,
          order_id: HyperlocalOrderLog.order_id,
          store_name: Store.store_name,
          staff_id: HyperlocalOrderLog.pos_admin_id,
          time_taken: timeTaken,
        }[input.sort];
        const result = await reader
          .select({
            id: HyperlocalOrderLog.id,
            orderId: HyperlocalOrderLog.order_id,
            staffId: HyperlocalOrderLog.pos_admin_id,
            storeId: Order.location_id,
            storeName: Store.store_name,
            createdAt: HyperlocalOrderLog.created_at,
            timeTaken,
          })
          .from(HyperlocalOrderLog)
          .leftJoin(Order, eq(Order.id, sql`${HyperlocalOrderLog.order_id}`))
          .leftJoin(Store, eq(Store.id, Order.location_id))
          .where(where)
          .orderBy(input.direction === 'asc' ? asc(sort) : desc(sort), asc(HyperlocalOrderLog.id))
          .limit(limit)
          .offset((page - 1) * input.pageSize);
        rows = z.array(rawSchema).parse(result);
      }
      if (all && rows.length > 70000)
        throw new AppError(
          422,
          'EXPORT_TOO_LARGE',
          'Select a smaller store/date range for export.',
        );
      const staffIds = [...new Set(rows.map((row) => row.staffId))],
        operators = staffIds.length
          ? await db
              .get('primary')
              .select({
                id: PosUser.id,
                firstName: PosUser.first_name,
                lastName: PosUser.last_name,
              })
              .from(PosUser)
              .where(inArray(PosUser.id, staffIds.map(BigInt)))
          : [];
      return {
        reader: bounds.reader,
        data: acceptanceRows(
          rows,
          new Map(
            operators.map((row) => [String(row.id), `${row.firstName} ${row.lastName}`.trim()]),
          ),
        ),
        total,
        page,
        totalPages,
      };
    },
  };
}
