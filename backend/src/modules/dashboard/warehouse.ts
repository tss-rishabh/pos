import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { warehouseService } from '../warehouse.js';
import type { DashboardAuthority } from './authority.js';
import { dashboardCount, monthlyRow, monthlySeries, dashboardMonths } from './domain.js';
import { dashboardPublicationContract, type DashboardOptions } from './options.js';

const unavailable = () =>
  new AppError(
    503,
    'DASHBOARD_PUBLICATION_UNAVAILABLE',
    'Dashboard history requires a complete, source-matching warehouse publication.',
  );
const invalid = () =>
  new AppError(
    503,
    'DASHBOARD_PUBLICATION_INVALID',
    'Dashboard history publication failed its source integrity contract.',
  );
const header = z
  .object({
    generation_id: z.uuid(),
    as_of: z.string(),
    contract: z.literal(dashboardPublicationContract),
  })
  .strict();
const manifest = z
  .object({
    store_id: identifier,
    source_count: dashboardCount,
    warehouse_count: dashboardCount,
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
    warehouse_hash: z.string().regex(/^[a-f0-9]{64}$/),
    complete: z.literal(true),
    as_of: z.string(),
    contract: z.literal(dashboardPublicationContract),
  })
  .strict();
const total = z
  .object({
    store_id: identifier,
    published_rows: dashboardCount,
    unique_rows: dashboardCount,
    order_count: dashboardCount,
  })
  .strict();
function publicationRows<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
export function dashboardWarehouse(
  config: Config,
  options: DashboardOptions,
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
) {
  return {
    async read(scope: DashboardAuthority, year: number, yearStart: string, now: Temporal.Instant) {
      if (
        !options.BQ_DASHBOARD_FACTS_VIEW ||
        !options.BQ_DASHBOARD_PUBLICATIONS_VIEW ||
        options.BQ_DASHBOARD_CONTRACT !== dashboardPublicationContract
      )
        throw unavailable();
      const facts = '`' + options.BQ_DASHBOARD_FACTS_VIEW + '`',
        publications = '`' + options.BQ_DASHBOARD_PUBLICATIONS_VIEW + '`';
      const headers = publicationRows(
        z.array(header).max(1),
        await warehouse.queryReport(
          `SELECT DISTINCT generation_id,FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',as_of,'UTC') AS as_of,contract FROM ${publications} WHERE complete=TRUE ORDER BY as_of DESC,generation_id DESC LIMIT 1`,
          {},
          {},
          'dashboard-publication',
        ),
      );
      const selected = headers[0];
      if (!selected) throw unavailable();
      let asOf: Temporal.Instant;
      try {
        asOf = Temporal.Instant.from(selected.as_of);
      } catch {
        throw invalid();
      }
      const age = now.epochNanoseconds - asOf.epochNanoseconds;
      if (
        age < -30000000000n ||
        age > BigInt(options.DASHBOARD_PUBLICATION_MAX_AGE_SECONDS) * 1000000000n
      )
        throw new AppError(
          503,
          'DASHBOARD_PUBLICATION_STALE',
          'Dashboard history publication is outside the accepted freshness window.',
        );
      const params = { generation: selected.generation_id, stores: scope.orderStoreIds },
        types = { generation: 'STRING', stores: ['STRING'] };
      const declarations = publicationRows(
        z.array(manifest).max(500),
        await warehouse.queryReport(
          `SELECT CAST(store_id AS STRING) AS store_id,CAST(source_count AS STRING) AS source_count,CAST(warehouse_count AS STRING) AS warehouse_count,source_hash,warehouse_hash,complete,FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',as_of,'UTC') AS as_of,contract FROM ${publications} WHERE generation_id=@generation AND CAST(store_id AS STRING) IN UNNEST(@stores)`,
          params,
          types,
          'dashboard-publication-stores',
        ),
      );
      const byStore = new Map(declarations.map((row) => [row.store_id, row]));
      if (
        byStore.size !== declarations.length ||
        byStore.size !== scope.orderStoreIds.length ||
        declarations.some(
          (row) =>
            !scope.orderStoreIds.includes(row.store_id) ||
            row.as_of !== selected.as_of ||
            row.source_count !== row.warehouse_count ||
            row.source_hash !== row.warehouse_hash,
        )
      )
        throw invalid();
      const totals = publicationRows(
        z.array(total).max(500),
        await warehouse.queryReport(
          `SELECT CAST(store_id AS STRING) AS store_id,CAST(COUNT(*) AS STRING) AS published_rows,CAST(COUNT(DISTINCT order_store_id) AS STRING) AS unique_rows,CAST(COUNTIF(order_status<>0) AS STRING) AS order_count FROM ${facts} WHERE generation_id=@generation AND CAST(store_id AS STRING) IN UNNEST(@stores) GROUP BY store_id`,
          params,
          types,
          'dashboard-order-count',
        ),
      );
      const counted = new Map(totals.map((row) => [row.store_id, row]));
      if (
        counted.size !== totals.length ||
        totals.some(
          (row) =>
            !byStore.has(row.store_id) ||
            row.unique_rows !== row.published_rows ||
            BigInt(row.order_count) > BigInt(row.published_rows),
        )
      )
        throw invalid();
      for (const [id, row] of byStore)
        if ((counted.get(id)?.published_rows || '0') !== row.warehouse_count) throw invalid();
      const monthly = publicationRows(
        z.array(monthlyRow).max(24000),
        await warehouse.queryReport(
          `SELECT CAST(store_id AS STRING) AS store_id,EXTRACT(YEAR FROM order_created_at) AS year,EXTRACT(MONTH FROM order_created_at) AS month,CAST(COUNT(*) AS STRING) AS order_count FROM ${facts} WHERE generation_id=@generation AND CAST(store_id AS STRING) IN UNNEST(@stores) AND order_status<>0 AND order_created_at>=@year_start GROUP BY store_id,year,month ORDER BY store_id,year,month LIMIT 24001`,
          {
            generation: selected.generation_id,
            stores: scope.graphStores.map((store) => store.id),
            year_start: yearStart,
          },
          { generation: 'STRING', stores: ['STRING'], year_start: 'DATETIME' },
          'dashboard-monthly-orders',
        ),
      );
      return {
        reader: 'bigquery' as const,
        asOf: selected.as_of,
        generationId: selected.generation_id,
        contract: dashboardPublicationContract,
        year,
        orderAssociations: totals
          .reduce((sum, row) => sum + BigInt(row.order_count), 0n)
          .toString(),
        months: dashboardMonths,
        series: monthlySeries(scope.graphStores, monthly, year),
      };
    },
  };
}
