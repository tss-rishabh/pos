import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import { AppError } from '../../../domain/errors.js';
import { warehouseService } from '../../warehouse.js';
import { orderHistorySdkEstimator, type OrderHistoryEstimator } from '../reader.js';
import { date, positiveId, count, hash, type OrderReadRange } from '../contracts.js';
import { historyRowsHash } from '../hashes.js';
import { sourceSearchContract, type SourceOrder, type SourceSearchScope } from './contracts.js';
import { sourceStoreSelection } from './native.js';
import {
  sourceIndexSchema,
  sourceFactSchema,
  assertFact,
  sourceFactHash,
  sourceIndex,
  compareIds,
  type SourceIndex,
} from './reducer.js';
import {
  readOrderSearchOptions,
  qualifiedSearchViews,
  searchPublicationRequired,
  searchPublicationInvalid,
  type OrderSearchOptions,
} from './options.js';
const timestamp = z.iso.datetime({ offset: true });
export const searchPublicationSchema = z
  .object({
    contract_version: z.literal(sourceSearchContract),
    generation_id: z.uuid(),
    scope_key: z.string().regex(/^(?:store:[1-9]\d{0,18}|global:0|order:[1-9]\d{0,18})$/),
    business_date: date,
    source_complete: z.literal(true),
    source_snapshot_id: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
    source_snapshot_at: timestamp,
    source_cdc_watermark: timestamp,
    published_at: timestamp,
    contact_key_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    source_rows: count,
    warehouse_rows: count,
    source_hash: hash,
    warehouse_hash: hash,
  })
  .strict();
export type SearchPublication = z.infer<typeof searchPublicationSchema>;
export const searchIndexRowSchema = z
  .object({
    scope_key: z.string(),
    business_date: date,
    order_id: positiveId,
    index_json: z.string().max(3000000),
    index_hash: hash,
  })
  .strict();
export function searchIndexRowsHash(rows: readonly z.infer<typeof searchIndexRowSchema>[]) {
  return historyRowsHash(
    [...rows]
      .sort((a, b) => compareIds(a.order_id, b.order_id))
      .map((row) => sourceFactHash(row.order_id + '\n' + row.index_hash)),
  );
}
export interface VerifiedSearchIndexes {
  indexes: SourceIndex[];
  generationId: string;
  facts(ids: readonly string[]): Promise<SourceOrder[]>;
}
export interface SourceHistorySearchPort {
  range(scope: SourceSearchScope, range: OrderReadRange): Promise<VerifiedSearchIndexes>;
  ids(
    scope: SourceSearchScope,
    ids: readonly string[],
    cutoff: string,
  ): Promise<VerifiedSearchIndexes>;
}
export function sourceHistoricalSearch(
  config: Config,
  options: OrderSearchOptions = readOrderSearchOptions(),
  dependencies: {
    query?: ReturnType<typeof warehouseService>['queryReport'];
    estimate?: OrderHistoryEstimator;
    clock?: () => number;
  } = {},
): SourceHistorySearchPort {
  const query = dependencies.query ?? warehouseService(config).queryReport,
    estimate = dependencies.estimate ?? orderHistorySdkEstimator(config),
    clock = dependencies.clock ?? Date.now;
  const parsed = <T>(schema: z.ZodType<T>, value: unknown) => {
    const result = schema.safeParse(value);
    if (!result.success) throw searchPublicationInvalid();
    return result.data;
  };
  const fields =
    'contract_version,generation_id,scope_key,CAST(business_date AS STRING) AS business_date,source_complete,source_snapshot_id,CAST(source_snapshot_at AS STRING) AS source_snapshot_at,CAST(source_cdc_watermark AS STRING) AS source_cdc_watermark,CAST(published_at AS STRING) AS published_at,contact_key_id,CAST(source_rows AS STRING) AS source_rows,CAST(warehouse_rows AS STRING) AS warehouse_rows,source_hash,warehouse_hash';
  // Timestamp fields remain native SDK timestamps so shared unwrapping emits ISO.
  const publicationFields = fields
    .replaceAll('CAST(source_snapshot_at AS STRING) AS source_snapshot_at', 'source_snapshot_at')
    .replaceAll(
      'CAST(source_cdc_watermark AS STRING) AS source_cdc_watermark',
      'source_cdc_watermark',
    )
    .replaceAll('CAST(published_at AS STRING) AS published_at', 'published_at');
  async function execute(
    statement: string,
    params: Record<string, unknown>,
    types: Record<string, string | string[]>,
    budget: { spent: bigint },
  ) {
    qualifiedSearchViews(options);
    const used = new Set(
      [...statement.matchAll(/@([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]!),
    );
    const bound = Object.fromEntries(Object.entries(params).filter(([key]) => used.has(key))),
      boundTypes = Object.fromEntries(Object.entries(types).filter(([key]) => used.has(key)));
    if ([...used].some((key) => !(key in bound) || !(key in boundTypes)))
      throw searchPublicationInvalid();
    const bytes = await estimate({ statement, params: bound, types: boundTypes });
    if (bytes < 0n || bytes + budget.spent > BigInt(config.BIGQUERY_MAX_BYTES_BILLED))
      throw new AppError(
        503,
        'ORDER_SEARCH_PROJECTION_REQUIRED',
        'This historical search requires a qualified projection within the configured query budget.',
      );
    budget.spent += bytes;
    return query(statement, bound, boundTypes, 'order-search');
  }
  function valid(p: SearchPublication) {
    const now = clock(),
      snapshot = Date.parse(p.source_snapshot_at),
      watermark = Date.parse(p.source_cdc_watermark),
      published = Date.parse(p.published_at);
    if (
      p.source_rows !== p.warehouse_rows ||
      p.source_hash !== p.warehouse_hash ||
      p.contact_key_id !== options.ORDER_SEARCH_CONTACT_KEY_ID ||
      snapshot > now + 5000 ||
      watermark > now + 5000 ||
      published > now + 5000 ||
      watermark < snapshot ||
      published + 5000 < watermark ||
      now - snapshot > options.ORDER_SEARCH_MAX_LAG_SECONDS * 1000
    )
      throw searchPublicationInvalid();
  }
  async function read(
    scope: SourceSearchScope,
    keys: string[],
    range: OrderReadRange | undefined,
    ids: readonly string[] | undefined,
    cutoff?: string,
  ): Promise<VerifiedSearchIndexes> {
    const views = qualifiedSearchViews(options),
      budget = { spent: 0n };
    if (!keys.length) throw searchPublicationRequired();
    const params: Record<string, unknown> = {
        contract: sourceSearchContract,
        scopeKeys: keys,
        take: options.ORDER_SEARCH_MAX_INDEX_ROWS + 1,
      },
      types: Record<string, string | string[]> = {
        contract: 'STRING',
        scopeKeys: ['STRING'],
        take: 'INT64',
      };
    let partition: string;
    if (range) {
      params.shards = [...new Set(keys.map((key) => Number(BigInt(key.split(':')[1]!) % 1024n)))];
      types.shards = ['INT64'];
      params.startDate = range.from;
      params.endDate = range.to;
      types.startDate = 'DATE';
      types.endDate = 'DATE';
      partition =
        'scope_shard IN UNNEST(@shards) AND business_date BETWEEN @startDate AND @endDate';
    } else {
      params.shards = [...new Set((ids ?? []).map((id) => Number(BigInt(id) % 1024n)))];
      types.shards = ['INT64'];
      partition = 'scope_shard IN UNNEST(@shards)';
    }
    const publications = parsed(
      z.array(searchPublicationSchema).max(62000),
      await execute(
        `SELECT ${publicationFields} FROM \`${views.publications}\` WHERE contract_version=@contract AND scope_key IN UNNEST(@scopeKeys) AND ${partition}`,
        params,
        types,
        budget,
      ),
    );
    const expected = new Set<string>();
    if (range) {
      for (
        let day = Temporal.PlainDate.from(range.from);
        Temporal.PlainDate.compare(day, range.to) <= 0;
        day = day.add({ days: 1 })
      )
        for (const key of keys) expected.add(key + '|' + day.toString());
    } else for (const key of keys) expected.add(key);
    if (publications.length !== expected.size) throw searchPublicationRequired();
    const seen = new Set<string>();
    let total = 0n;
    for (const p of publications) {
      valid(p);
      const key = range ? p.scope_key + '|' + p.business_date : p.scope_key;
      if (!expected.has(key) || seen.has(key)) throw searchPublicationInvalid();
      seen.add(key);
      total += BigInt(p.source_rows);
      if (!range && BigInt(p.source_rows) > 1n) throw searchPublicationInvalid();
    }
    const first = publications[0];
    if (!first) throw searchPublicationRequired();
    if (
      publications.some(
        (p) =>
          p.generation_id !== first.generation_id ||
          p.source_snapshot_id !== first.source_snapshot_id ||
          p.source_snapshot_at !== first.source_snapshot_at ||
          p.source_cdc_watermark !== first.source_cdc_watermark ||
          p.published_at !== first.published_at,
      )
    )
      throw searchPublicationInvalid();
    if (total > BigInt(options.ORDER_SEARCH_MAX_INDEX_ROWS))
      throw new AppError(
        422,
        'ORDER_SEARCH_TOO_LARGE',
        'Narrow the dates or stores; the complete historical search exceeds its safety bound.',
      );
    params.generation = first.generation_id;
    types.generation = 'STRING';
    params.days = [...new Set(publications.map((p) => p.business_date))];
    types.days = ['DATE'];
    const indexRows = parsed(
      z.array(searchIndexRowSchema).max(options.ORDER_SEARCH_MAX_INDEX_ROWS + 1),
      await execute(
        `SELECT scope_key,CAST(business_date AS STRING) AS business_date,order_id,index_json,index_hash FROM \`${views.index}\` WHERE contract_version=@contract AND generation_id=@generation AND scope_key IN UNNEST(@scopeKeys) AND business_date IN UNNEST(@days) ORDER BY scope_key,business_date,CAST(order_id AS BIGNUMERIC) LIMIT @take`,
        params,
        types,
        budget,
      ),
    );
    if (BigInt(indexRows.length) !== total) throw searchPublicationInvalid();
    const groups = new Map<string, z.infer<typeof searchIndexRowSchema>[]>(),
      indexes = new Map<string, SourceIndex>();
    for (const row of indexRows) {
      const identity = row.scope_key + '|' + row.business_date;
      if (
        !publications.some(
          (p) => p.scope_key === row.scope_key && p.business_date === row.business_date,
        ) ||
        sourceFactHash(row.index_json) !== row.index_hash
      )
        throw searchPublicationInvalid();
      let raw: unknown;
      try {
        raw = JSON.parse(row.index_json) as unknown;
      } catch {
        throw searchPublicationInvalid();
      }
      const item = parsed(sourceIndexSchema, raw);
      // A valid digest must not turn missing comparison/dimension evidence into
      // an empty filtered report. Native padded weights are never empty strings.
      if (
        !/^[a-f0-9]{64}$/.test(item.phoneKey) ||
        (item.customerPresent
          ? item.userPhoneKey === null ||
            item.emailKey === null ||
            !hash.safeParse(item.userPhoneKey).success ||
            !hash.safeParse(item.emailKey).success ||
            !item.userFirstKey
          : item.userPhoneKey !== null || item.emailKey !== null || item.userFirstKey !== null) ||
        new Set(item.stores.map((row) => row.id)).size !== item.stores.length ||
        new Set(item.expressStoreIds).size !== item.expressStoreIds.length
      )
        throw searchPublicationInvalid();
      try {
        Temporal.PlainDateTime.from(item.createdAt.replace(' ', 'T'));
      } catch {
        throw searchPublicationInvalid();
      }
      if (
        item.id !== row.order_id ||
        item.createdAt.slice(0, 10) !== row.business_date ||
        (!range && (!ids?.includes(item.id) || !cutoff || item.createdAt >= cutoff))
      )
        throw searchPublicationInvalid();
      if (row.scope_key.startsWith('store:')) {
        const store = row.scope_key.slice(6);
        if (
          !item.stores.some((r) => r.storeId === store) &&
          !item.expressStoreIds.includes(store) &&
          item.locationStoreId !== store
        )
          throw searchPublicationInvalid();
      }
      if (row.scope_key.startsWith('order:') && row.scope_key !== 'order:' + item.id)
        throw searchPublicationInvalid();
      const previous = indexes.get(item.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(item))
        throw searchPublicationInvalid();
      indexes.set(item.id, item);
      const group = groups.get(identity) ?? [];
      if (group.some((r) => r.order_id === row.order_id)) throw searchPublicationInvalid();
      group.push(row);
      groups.set(identity, group);
    }
    for (const p of publications) {
      const group = groups.get(p.scope_key + '|' + p.business_date) ?? [];
      if (String(group.length) !== p.source_rows || searchIndexRowsHash(group) !== p.source_hash)
        throw searchPublicationInvalid();
    }
    return {
      indexes: [...indexes.values()],
      generationId: first.generation_id,
      async facts(wanted) {
        const selected = [...new Set(wanted)];
        if (!selected.length) return [];
        if (selected.length > 100 || selected.some((id) => !indexes.has(id)))
          throw searchPublicationInvalid();
        const raw = await execute(
          `SELECT order_id,CAST(business_date AS STRING) AS business_date,fact_json,fact_hash FROM \`${views.facts}\` WHERE contract_version=@contract AND generation_id=@generation AND business_date IN UNNEST(@days) AND order_shard IN UNNEST(@orderShards) AND order_id IN UNNEST(@orders)`,
          {
            ...params,
            orders: selected,
            orderShards: [...new Set(selected.map((id) => Number(BigInt(id) % 8192n)))],
          },
          { ...types, orders: ['STRING'], orderShards: ['INT64'] },
          budget,
        );
        const rows = parsed(
          z
            .array(
              z
                .object({
                  order_id: positiveId,
                  business_date: date,
                  fact_json: z.string().max(4000000),
                  fact_hash: hash,
                })
                .strict(),
            )
            .max(100),
          raw,
        );
        if (
          rows.length !== selected.length ||
          new Set(rows.map((r) => r.order_id)).size !== selected.length
        )
          throw searchPublicationInvalid();
        const result: SourceOrder[] = [];
        for (const row of rows) {
          const index = indexes.get(row.order_id);
          if (
            !index ||
            !selected.includes(row.order_id) ||
            index.factHash !== row.fact_hash ||
            sourceFactHash(row.fact_json) !== row.fact_hash
          )
            throw searchPublicationInvalid();
          let value: unknown;
          try {
            value = JSON.parse(row.fact_json) as unknown;
          } catch {
            throw searchPublicationInvalid();
          }
          const fact = assertFact(parsed(sourceFactSchema, value));
          if (
            fact.id !== row.order_id ||
            fact.createdAt.slice(0, 10) !== row.business_date ||
            JSON.stringify(sourceIndex(fact, row.fact_hash)) !== JSON.stringify(index)
          )
            throw searchPublicationInvalid();
          result.push(fact);
        }
        return result;
      },
    };
  }
  return {
    range(scope, range) {
      if (range.reader !== 'bigquery') throw searchPublicationInvalid();
      const stores = sourceStoreSelection(scope);
      const keys =
        scope.effectiveType === 'N' || (scope.internal && scope.explicitIds)
          ? ['global:0']
          : stores.map((id) => 'store:' + id);
      return read(scope, keys, range, undefined);
    },
    ids(scope, ids, cutoff) {
      if (
        !ids.length ||
        ids.length > options.ORDER_SEARCH_MAX_QUEUE_ORDERS ||
        new Set(ids).size !== ids.length
      )
        throw searchPublicationInvalid();
      ids.forEach((id) => positiveId.parse(id));
      return read(
        scope,
        ids.map((id) => 'order:' + id),
        undefined,
        ids,
        cutoff,
      );
    },
  };
}
