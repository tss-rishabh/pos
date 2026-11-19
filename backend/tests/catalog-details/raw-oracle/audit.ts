// Frozen pre-W11 copy (integration head 43613a75) of the raw-SQL implementation. Characterisation
// oracle only: tests/catalog-details/orm-characterisation.mysql.test.ts compares it with src.
import { Temporal } from '@js-temporal/polyfill';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../src/config.js';
import type { Databases } from '../../../src/db/pools.js';
import type { Principal } from '../../../src/domain/access.js';
import { requireStore } from '../../../src/domain/access.js';
import { unavailable } from '../../../src/domain/errors.js';
import { warehouseService } from '../../../src/modules/warehouse.js';
import { timestampReportBounds } from '../../../src/modules/operational-reports/report-inputs.js';
import {
  auditRow,
  auditSearchInput,
  catalogDetailOptions,
  countValue,
  type AuditKind,
  type AuditSearchInput,
  type CatalogDetailOptions,
} from '../../../src/modules/catalog-details/contracts.js';
import {
  sourcePageStart,
  sourcePosUserFullName,
  sourceStockDelta,
} from '../../../src/modules/catalog-details/domain.js';
import { assertCatalogScope } from './service.js';

/** Normalized physical source projection, including the legacy storage join by stock-row ID. */
export function inventoryAuditSource(kind: AuditKind) {
  const table =
    kind === 'product'
      ? sql`pos_product_inventory_logs`
      : kind === 'held'
        ? sql`pos_hold_stock_logs`
        : sql`stock_storage_logs`;
  const userJoin = kind === 'product' ? sql`left join users u on u.id=l.user_id` : sql``;
  const customerName =
    kind === 'product'
      ? sql`concat(coalesce(u.firstname,''),case when coalesce(u.lastname,'')='' then '' else concat(' ',u.lastname) end)`
      : sql`''`;
  const storageJoin =
    kind === 'storage'
      ? sql`left join stock_storages ss on ss.id=l.storage_id left join store_storages sss on sss.id=ss.id`
      : sql``;
  return sql`select l.id as id,l.store_id as store_id,s.store_name,s.type as store_type,s.is_active as store_active,${kind === 'storage' ? sql`sss.storage_name` : sql`null`} as storage_name,l.product_id as product_id,p.product,p.erp_product,l.stock_before,l.stock_after,
    case when coalesce(l.pos_user_id,0)<>0 then case when pu.id is null then null else trim(concat(coalesce(pu.first_name,''),' ',coalesce(pu.last_name,''))) end else ${customerName} end as user,
    ${kind === 'product' ? sql`u.firstname` : sql`null`} as firstname,${kind === 'product' ? sql`u.lastname` : sql`null`} as lastname,l.pos_user_id as _pos_user_id,pu.id as _pos_user_exists,pu.first_name as _pos_first_name,pu.last_name as _pos_last_name,l.comment,l.created_at
    from ${table} l join products p on p.id=l.product_id left join stores s on s.id=l.store_id left join pos_user pu on pu.id=l.pos_user_id ${userJoin} ${storageJoin}`;
}
export function inventoryAuditService(
  config: Config,
  db: Databases,
  options: CatalogDetailOptions = catalogDetailOptions(),
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = () => Temporal.Now.instant(),
) {
  return {
    async search(user: Principal, productId: string, kind: AuditKind, value: AuditSearchInput) {
      const input = auditSearchInput.parse(value);
      input.storeIds = [...new Set(input.storeIds)];
      assertCatalogScope(user, input.storeIds);
      if (kind === 'storage') input.storeIds.forEach((id) => requireStore(user, id));
      const bounds = timestampReportBounds(config, input.from, input.to, clock());
      if (!input.storeIds.length)
        return {
          reader: bounds.reader,
          draw: input.draw,
          recordsTotal: 0,
          recordsFiltered: 0,
          unfilteredCount: 0,
          start: 0,
          data: [],
        };
      const pattern = `%${input.search.replaceAll('"', "'")}%`;
      let unfiltered: number, filtered: number, start: number, rows: z.infer<typeof auditRow>[];
      if (bounds.reader === 'bigquery') {
        const view =
          kind === 'product'
            ? options.BQ_PRODUCT_INVENTORY_AUDIT_VIEW
            : kind === 'held'
              ? options.BQ_HELD_INVENTORY_AUDIT_VIEW
              : options.BQ_STORAGE_INVENTORY_AUDIT_VIEW;
        if (!view) return unavailable('BigQuery inventory audit view');
        const params = {
            product: productId,
            stores: input.storeIds,
            start: bounds.from,
            end: bounds.to,
            search: pattern,
            hasSearch: !!input.search,
          },
          types = {
            product: 'STRING',
            stores: ['STRING'],
            start: 'DATETIME',
            end: 'DATETIME',
            search: 'STRING',
            hasSearch: 'BOOL',
          };
        const scope =
          'CAST(product_id AS STRING)=@product AND CAST(store_id AS STRING) IN UNNEST(@stores) AND created_at>=@start AND created_at<=@end AND store_active=TRUE' +
          (kind === 'storage' ? " AND store_type='STORE'" : '');
        if (input.search && !options.BQ_INVENTORY_AUDIT_LIKE_UDF)
          return unavailable('BigQuery source-compatible inventory search function');
        // A configured UDF reproduces each physical source column's LIKE collation and escape rules.
        // LOWER/Unicode normalization would silently change accent/case/wildcard matches.
        const fields = [
          'product_id',
          'product',
          'created_at',
          'store_name',
          ...(kind === 'product' ? ['firstname', 'lastname'] : []),
          ...(kind === 'storage' ? ['storage_name'] : []),
        ];
        const match = input.search
          ? '(' +
            fields
              .map(
                (field) =>
                  `\`${options.BQ_INVENTORY_AUDIT_LIKE_UDF}\`(CAST(${field} AS STRING),@search,'${kind}.${field}')`,
              )
              .join(' OR ') +
            ')'
          : 'TRUE';
        const [counts] = z
          .array(z.object({ unfiltered_count: countValue, filtered_count: countValue }))
          .parse(
            await warehouse.queryReport(
              `SELECT COUNT(*) AS unfiltered_count,COUNTIF(NOT @hasSearch OR ${match}) AS filtered_count FROM \`${view}\` WHERE ${scope}`,
              params,
              types,
              'catalog-inventory-audit',
            ),
          );
        unfiltered = counts?.unfiltered_count || 0;
        filtered = counts?.filtered_count || 0;
        start = sourcePageStart(input.start, input.length, filtered);
        rows = z
          .array(auditRow)
          .parse(
            await warehouse.queryReport(
              `SELECT CAST(id AS STRING) AS id,CAST(store_id AS STRING) AS store_id,store_name,storage_name,CAST(product_id AS STRING) AS product_id,product,erp_product,stock_before,stock_after,user,comment,CAST(created_at AS STRING) AS created_at FROM \`${view}\` WHERE ${scope} AND (NOT @hasSearch OR ${match}) ORDER BY ${input.sort === 'id' || input.sort === 'product_id' ? `CAST(${input.sort} AS BIGNUMERIC)` : input.sort === 'created_at' ? 'created_at' : input.sort + '_sort_key'} ${input.direction.toUpperCase()},CAST(id AS BIGNUMERIC) ASC LIMIT @limit OFFSET @offset`,
              { ...params, limit: input.length, offset: start },
              { ...types, limit: 'INT64', offset: 'INT64' },
              'catalog-inventory-audit',
            ),
          );
      } else {
        const source = inventoryAuditSource(kind),
          scope = sql`a.product_id=${productId} and a.store_id in (${sql.join(
            input.storeIds.map((id) => sql`${id}`),
            sql`,`,
          )}) and a.created_at>=${bounds.from} and a.created_at<=${bounds.to} and a.store_active=1 ${kind === 'storage' ? sql`and a.store_type='STORE'` : sql``}`;
        const match = input.search
          ? sql`(a.product_id like ${pattern} or a.product like ${pattern} or a.created_at like ${pattern} or a.store_name like ${pattern} ${kind === 'product' ? sql`or a.firstname like ${pattern} or a.lastname like ${pattern}` : sql``} ${kind === 'storage' ? sql`or a.storage_name like ${pattern}` : sql``})`
          : sql`true`;
        const [counts] = z
          .array(z.object({ unfiltered_count: countValue, filtered_count: countValue }))
          .parse(
            (
              await db
                .get('data')
                .execute(
                  sql`select count(*) as unfiltered_count,coalesce(sum(case when ${match} then 1 else 0 end),0) as filtered_count from (${source}) a where ${scope}`,
                )
            )[0],
          );
        unfiltered = counts?.unfiltered_count || 0;
        filtered = counts?.filtered_count || 0;
        start = sourcePageStart(input.start, input.length, filtered);
        rows = z
          .array(
            auditRow.extend({
              _pos_user_id: z.union([z.string(), z.number(), z.bigint()]).nullable(),
              _pos_user_exists: z.union([z.string(), z.number(), z.bigint()]).nullable(),
              _pos_first_name: z.string().nullable(),
              _pos_last_name: z.string().nullable(),
            }),
          )
          .parse(
            (
              await db
                .get('data')
                .execute(
                  sql`select a.* from (${source}) a where ${scope} and ${match} order by ${sql.identifier(input.sort)} ${input.direction === 'asc' ? sql`asc` : sql`desc`},a.id asc limit ${input.length} offset ${start}`,
                )
            )[0],
          )
          .map(({ _pos_user_id, _pos_user_exists, _pos_first_name, _pos_last_name, ...row }) => ({
            ...row,
            user:
              _pos_user_id !== null && String(_pos_user_id) !== '0' && _pos_user_exists !== null
                ? sourcePosUserFullName(_pos_first_name, _pos_last_name)
                : row.user,
          }));
      }
      return {
        reader: bounds.reader,
        draw: input.draw,
        recordsTotal: filtered,
        recordsFiltered: filtered,
        unfilteredCount: unfiltered,
        start,
        data: rows.map((row, index) => ({
          ...row,
          id: kind === 'storage' ? String(index + 1) : row.id,
          DT_RowId: row.id,
          added_reduced: sourceStockDelta(row.stock_before, row.stock_after),
        })),
      };
    },
  };
}
