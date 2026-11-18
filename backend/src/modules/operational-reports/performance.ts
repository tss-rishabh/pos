import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { HasProduct, MUser, Order, SalesPerson, Store } from '../../db/legacy-schema.js';
import { requireRole, type Principal } from '../../domain/access.js';
import { identifier } from '../../domain/validation.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import {
  businessTimestamp,
  scalarId,
  staffReportScope,
  timestampReportBounds,
  warehouseView,
} from './report-inputs.js';
import {
  cashierPerformance,
  salespersonRatings,
  type CashierPerformanceRecord,
} from './performance-domain.js';
import { PerformanceOrderStore as OrderStore } from './performance-schema.js';
const common = {
  from: businessTimestamp,
  to: businessTimestamp,
  storeIds: z.array(identifier).max(500).default([]),
  direction: z.enum(['asc', 'desc']).default('desc'),
  page: z.number().int().min(1).max(1000000).default(1),
  pageSize: z.number().int().min(1).max(500).default(25),
};
export const salespersonInputSchema = z
  .object({
    ...common,
    sort: z
      .enum(['store_name', 'employee_id', 'salesperson_name', 'total_sales', 'rating'])
      .default('total_sales'),
  })
  .strict();
export const cashierInputSchema = z
  .object({
    ...common,
    sort: z
      .enum(['cashier_name', 'cashier_id', 'product_sold', 'time_taken', 'rating'])
      .default('rating'),
  })
  .strict();
export type SalespersonInput = z.infer<typeof salespersonInputSchema>;
export type CashierInput = z.infer<typeof cashierInputSchema>;
export function performanceOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BQ_SALESPERSON_PERFORMANCE_VIEW: warehouseView,
      BQ_CASHIER_PERFORMANCE_VIEW: warehouseView,
    })
    .parse(env);
}
const numeric = z.union([
    z.number().finite(),
    z.string().regex(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i),
  ]),
  salespersonRecord = z.object({
    employeeId: z.string(),
    storeName: z.string().nullable(),
    salespersonName: z.string().nullable(),
    totalSales: numeric,
  }),
  cashierRecord = z.object({
    orderId: scalarId,
    cashierId: scalarId.nullable(),
    cashierName: z.string().nullable(),
    performanceJson: z.string().max(255),
    quantity: numeric.nullable(),
  });
function pageRows<T>(rows: T[], page: number, pageSize: number, all = false) {
  if (rows.length > 70000)
    throw new AppError(422, 'REPORT_TOO_LARGE', 'Select a smaller store/date range.');
  const totalPages = Math.ceil(rows.length / pageSize),
    selected = !all && page <= totalPages ? page : 1;
  return {
    data: all ? rows : rows.slice((selected - 1) * pageSize, selected * pageSize),
    total: rows.length,
    page: selected,
    totalPages,
  };
}
export function staffPerformanceService(
  config: Config,
  db: Databases,
  options: ReturnType<typeof performanceOptions> = performanceOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async salespeople(user: Principal, value: SalespersonInput, all = false) {
      requireRole(user, [1]);
      const input = salespersonInputSchema.parse(value),
        bounds = timestampReportBounds(config, input.from, input.to, clock()),
        scope = staffReportScope(user, input.storeIds);
      if (scope.empty) return { reader: bounds.reader, ...pageRows([], 1, input.pageSize) };
      let rows: z.infer<typeof salespersonRecord>[];
      if (bounds.reader === 'bigquery') {
        if (!options.BQ_SALESPERSON_PERFORMANCE_VIEW)
          return unavailable('BigQuery salesperson performance view');
        const sort = {
            store_name: 'storeName',
            employee_id: 'employeeId',
            salesperson_name: 'salespersonName',
            total_sales: 'totalSales',
            rating: 'totalSales',
          }[input.sort],
          view = '`' + options.BQ_SALESPERSON_PERFORMANCE_VIEW + '`';
        const result = await warehouse.queryReport(
          `SELECT employee_id AS employeeId,ANY_VALUE(store_name) AS storeName,ANY_VALUE(salesperson_name) AS salespersonName,SUM(price) AS totalSales FROM ${view} WHERE line_created_at>=@start AND line_created_at<=@end AND (@allStores OR CAST(store_id AS STRING) IN UNNEST(@stores)) GROUP BY employee_id ORDER BY ${sort} ${input.direction},employeeId ASC LIMIT 70001`,
          { start: bounds.from, end: bounds.to, allStores: !scope.ids.length, stores: scope.ids },
          { start: 'DATETIME', end: 'DATETIME', allStores: 'BOOL', stores: ['STRING'] },
          'salesperson-performance',
        );
        rows = z.array(salespersonRecord).parse(result);
      } else {
        const total = sql<number>`sum(${HasProduct.price})`,
          name = sql<
            string | null
          >`any_value(concat(${SalesPerson.first_name},' ',${SalesPerson.last_name}))`,
          storeName = sql<string | null>`any_value(${Store.store_name})`,
          sort = {
            store_name: storeName,
            employee_id: SalesPerson.employee_id,
            salesperson_name: name,
            total_sales: total,
            rating: total,
          }[input.sort];
        const result = await db
          .get('data')
          .select({
            employeeId: SalesPerson.employee_id,
            storeName,
            salespersonName: name,
            totalSales: total,
          })
          .from(OrderStore)
          .leftJoin(HasProduct, eq(HasProduct.order, OrderStore.orderId))
          .leftJoin(
            SalesPerson,
            eq(
              SalesPerson.id,
              sql`case when ${HasProduct.salesperson_id}=0 then ${OrderStore.salespersonId} else ${HasProduct.salesperson_id} end`,
            ),
          )
          .leftJoin(Store, eq(Store.id, OrderStore.storeId))
          .where(
            and(
              eq(HasProduct.status, 'DELIVERED'),
              sql`nullif(${SalesPerson.employee_id},'') is not null`,
              gte(HasProduct.created_at, bounds.from),
              lte(HasProduct.created_at, bounds.to),
              scope.ids.length ? inArray(OrderStore.storeId, scope.ids.map(BigInt)) : undefined,
            ),
          )
          .groupBy(SalesPerson.employee_id)
          .orderBy(input.direction === 'asc' ? asc(sort) : desc(sort), asc(SalesPerson.employee_id))
          .limit(70001);
        rows = z.array(salespersonRecord).parse(result);
      }
      return {
        reader: bounds.reader,
        ...pageRows(salespersonRatings(rows), input.page, input.pageSize, all),
      };
    },
    async cashiers(user: Principal, value: CashierInput, all = false) {
      requireRole(user, [1]);
      const input = cashierInputSchema.parse(value),
        bounds = timestampReportBounds(config, input.from, input.to, clock()),
        scope = staffReportScope(user, input.storeIds);
      if (scope.empty) return { reader: bounds.reader, ...pageRows([], 1, input.pageSize) };
      let rows: CashierPerformanceRecord[];
      if (bounds.reader === 'bigquery') {
        if (!options.BQ_CASHIER_PERFORMANCE_VIEW)
          return unavailable('BigQuery cashier performance view');
        const view = '`' + options.BQ_CASHIER_PERFORMANCE_VIEW + '`',
          result = await warehouse.queryReport(
            `SELECT order_id AS orderId,CAST(ANY_VALUE(cashier_id) AS STRING) AS cashierId,ANY_VALUE(cashier_name) AS cashierName,ANY_VALUE(performance_json) AS performanceJson,SUM(line_qty) AS quantity FROM ${view} WHERE order_created_at>=@start AND order_created_at<=@end AND NULLIF(performance_json,'') IS NOT NULL AND (@allStores OR CAST(store_id AS STRING) IN UNNEST(@stores)) GROUP BY order_id ORDER BY order_id ASC LIMIT 70001`,
            { start: bounds.from, end: bounds.to, allStores: !scope.ids.length, stores: scope.ids },
            { start: 'DATETIME', end: 'DATETIME', allStores: 'BOOL', stores: ['STRING'] },
            'cashier-performance',
          );
        rows = z.array(cashierRecord).parse(result);
      } else {
        const result = await db
          .get('data')
          .select({
            orderId: OrderStore.orderId,
            cashierId: sql<string | null>`cast(any_value(${OrderStore.adminUserId}) as char)`,
            cashierName: sql<
              string | null
            >`any_value(concat(${MUser.firstname},' ',${MUser.lastname}))`,
            performanceJson: sql<string>`any_value(${OrderStore.performanceJson})`,
            quantity: sql<string | null>`sum(${HasProduct.qty})`,
          })
          .from(Order)
          .leftJoin(OrderStore, eq(OrderStore.orderId, Order.id))
          .leftJoin(MUser, eq(MUser.id, sql`${OrderStore.adminUserId}`))
          .leftJoin(HasProduct, eq(HasProduct.order, Order.id))
          .where(
            and(
              sql`nullif(${OrderStore.performanceJson},'') is not null`,
              gte(Order.created_at, bounds.from),
              lte(Order.created_at, bounds.to),
              scope.ids.length ? inArray(OrderStore.storeId, scope.ids.map(BigInt)) : undefined,
            ),
          )
          .groupBy(OrderStore.orderId)
          .orderBy(asc(OrderStore.orderId))
          .limit(70001);
        rows = z.array(cashierRecord).parse(result);
      }
      if (rows.length > 70000)
        throw new AppError(422, 'REPORT_TOO_LARGE', 'Select a smaller store/date range.');
      return {
        reader: bounds.reader,
        ...pageRows(
          cashierPerformance(rows, input.sort, input.direction),
          input.page,
          input.pageSize,
          all,
        ),
      };
    },
  };
}
