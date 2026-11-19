import { Temporal } from '@js-temporal/polyfill';
import { and, asc, count, desc, eq, gte, inArray, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  MUser,
  PosHoldStockLog,
  PosUser,
  Product,
  ProductInventoryLog,
  StockStorage,
  StorageStockLog,
  Store,
  StoreStorage,
} from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
import { unavailable } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import { timestampReportBounds } from '../operational-reports/report-inputs.js';
import {
  auditRow,
  auditSearchInput,
  catalogDetailOptions,
  countValue,
  type AuditKind,
  type AuditSearchInput,
  type CatalogDetailOptions,
} from './contracts.js';
import { sourcePageStart, sourcePosUserFullName, sourceStockDelta } from './domain.js';
import { assertCatalogScope } from './service.js';

function auditLog(kind: AuditKind) {
  if (kind === 'product')
    return {
      table: ProductInventoryLog,
      id: ProductInventoryLog.id,
      store: ProductInventoryLog.store_id,
      product: ProductInventoryLog.product_id,
      before: ProductInventoryLog.stock_before,
      after: ProductInventoryLog.stock_after,
      posUser: ProductInventoryLog.pos_user_id,
      comment: ProductInventoryLog.comment,
      createdAt: ProductInventoryLog.created_at,
    };
  if (kind === 'held')
    return {
      table: PosHoldStockLog,
      id: PosHoldStockLog.id,
      store: PosHoldStockLog.store_id,
      product: PosHoldStockLog.product_id,
      before: PosHoldStockLog.stock_before,
      after: PosHoldStockLog.stock_after,
      posUser: PosHoldStockLog.pos_user_id,
      comment: PosHoldStockLog.comment,
      createdAt: PosHoldStockLog.created_at,
    };
  return {
    table: StorageStockLog,
    id: StorageStockLog.id,
    store: StorageStockLog.store,
    product: StorageStockLog.product,
    before: StorageStockLog.stock_before,
    after: StorageStockLog.stock_after,
    posUser: StorageStockLog.pos_user_id,
    comment: StorageStockLog.comment,
    createdAt: StorageStockLog.created_at,
  };
}
/**
 * Normalized physical source projection, including the legacy storage join by stock-row ID.
 * The source wrapped it in a mergeable derived table (`select a.* from (...) a`); the builder
 * applies the same filters, search and order directly to the joined rows.
 */
export function inventoryAuditSource(kind: AuditKind) {
  const log = auditLog(kind);
  const customerName =
    kind === 'product'
      ? sql<string>`concat(coalesce(${MUser.firstname},''),case when coalesce(${MUser.lastname},'')='' then '' else concat(' ',${MUser.lastname}) end)`
      : sql<string>`''`;
  const fields = {
    id: log.id,
    store_id: log.store,
    store_name: Store.store_name,
    storage_name: kind === 'storage' ? StoreStorage.storage_name : sql<string | null>`null`,
    product_id: log.product,
    product: Product.product,
    erp_product: Product.erp_product,
    stock_before: log.before,
    stock_after: log.after,
    user: sql<
      string | null
    >`case when coalesce(${log.posUser},0)<>0 then case when ${PosUser.id} is null then null else trim(concat(coalesce(${PosUser.first_name},''),' ',coalesce(${PosUser.last_name},''))) end else ${customerName} end`,
    comment: log.comment,
    created_at: log.createdAt,
    _pos_user_id: log.posUser,
    _pos_user_exists: PosUser.id,
    _pos_first_name: PosUser.first_name,
    _pos_last_name: PosUser.last_name,
  };
  const sort = {
    id: log.id,
    store_name: Store.store_name,
    // The source sorts the product and held projections by a constant NULL storage name.
    storage_name: kind === 'storage' ? StoreStorage.storage_name : undefined,
    product_id: log.product,
    product: Product.product,
    erp_product: Product.erp_product,
    created_at: log.createdAt,
  };
  return {
    log,
    fields,
    sort,
    scope: (productId: string, storeIds: readonly string[], from: string, to: string) =>
      and(
        eq(log.product, BigInt(productId)),
        inArray(log.store, storeIds.map(BigInt)),
        gte(log.createdAt, from),
        lte(log.createdAt, to),
        eq(Store.is_active, true),
        kind === 'storage' ? eq(Store.type, 'STORE') : undefined,
      ),
    match: (pattern: string) =>
      or(
        like(log.product, pattern),
        like(Product.product, pattern),
        like(log.createdAt, pattern),
        like(Store.store_name, pattern),
        ...(kind === 'product'
          ? [like(MUser.firstname, pattern), like(MUser.lastname, pattern)]
          : []),
        ...(kind === 'storage' ? [like(StoreStorage.storage_name, pattern)] : []),
      ),
    /** `from l join products p left join stores s left join pos_user pu [users u] [storages]`. */
    joins: {
      product: eq(Product.id, log.product),
      store: eq(Store.id, log.store),
      posUser: eq(PosUser.id, log.posUser),
      user: kind === 'product' ? eq(MUser.id, ProductInventoryLog.user_id) : undefined,
      storage: kind === 'storage' ? eq(StockStorage.id, StorageStockLog.storage) : undefined,
      storageName: kind === 'storage' ? eq(StoreStorage.id, StockStorage.id) : undefined,
    },
  };
}
type AuditSource = ReturnType<typeof inventoryAuditSource>;
function auditCount(reader: ReturnType<Databases['get']>, source: AuditSource, match?: SQL) {
  let query = reader
    .select({
      unfiltered_count: count(),
      filtered_count: match
        ? sql<string>`coalesce(sum(case when ${match} then 1 else 0 end),0)`
        : count(),
    })
    .from(source.log.table)
    .innerJoin(Product, source.joins.product)
    .leftJoin(Store, source.joins.store)
    .leftJoin(PosUser, source.joins.posUser)
    .$dynamic();
  if (source.joins.user) query = query.leftJoin(MUser, source.joins.user);
  if (source.joins.storage && source.joins.storageName)
    query = query
      .leftJoin(StockStorage, source.joins.storage)
      .leftJoin(StoreStorage, source.joins.storageName);
  return query;
}
function auditRows(reader: ReturnType<Databases['get']>, source: AuditSource) {
  let query = reader
    .select(source.fields)
    .from(source.log.table)
    .innerJoin(Product, source.joins.product)
    .leftJoin(Store, source.joins.store)
    .leftJoin(PosUser, source.joins.posUser)
    .$dynamic();
  if (source.joins.user) query = query.leftJoin(MUser, source.joins.user);
  if (source.joins.storage && source.joins.storageName)
    query = query
      .leftJoin(StockStorage, source.joins.storage)
      .leftJoin(StoreStorage, source.joins.storageName);
  return query;
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
          scope = source.scope(productId, input.storeIds, bounds.from, bounds.to);
        const match = input.search ? source.match(pattern) : undefined;
        const [counts] = z
          .array(z.object({ unfiltered_count: countValue, filtered_count: countValue }))
          .parse(await auditCount(db.get('data'), source, match).where(scope));
        unfiltered = counts?.unfiltered_count || 0;
        filtered = counts?.filtered_count || 0;
        start = sourcePageStart(input.start, input.length, filtered);
        const sort = source.sort[input.sort],
          direction = input.direction === 'asc' ? asc : desc;
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
            await auditRows(db.get('data'), source)
              .where(and(scope, match))
              .orderBy(...(sort ? [direction(sort)] : []), asc(source.log.id))
              .limit(input.length)
              .offset(start),
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
