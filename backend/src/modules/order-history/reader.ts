import { BigQuery } from '@google-cloud/bigquery';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { warehouseService } from '../warehouse.js';
import { normalizeWarehouseParameters } from '../warehouse-parameters.js';
import {
  copyHeader,
  copyLine,
  copySource,
  count,
  date,
  hash,
  historyHeader,
  historyLine,
  historyStore,
  orderHistoryContract,
  orderRange,
  positiveId,
  sourceDate,
  type OrderHistoryEvidence,
  type OrderHistoryPort,
  type HistoryOrderInput,
  type HistoryHeader,
  type HistoryLine,
  type HistoryStore,
} from './contracts.js';
import { historyRowsHash, historyOrderHash, historyCopyHash } from './hashes.js';
import {
  historyListSql,
  historyOrderSql,
  historyCopySql,
  historyPointPublicationSql,
  type OrderHistoryStatement,
} from './sql.js';
import {
  historyInvalid,
  historyRequired,
  qualifiedOrderViews,
  readOrderHistoryOptions,
  type OrderHistoryOptions,
} from './options.js';
export type OrderHistoryEstimator = (query: OrderHistoryStatement) => Promise<bigint>;
type QueryReport = ReturnType<typeof warehouseService>['queryReport'];
export function orderHistorySdkEstimator(config: Config): OrderHistoryEstimator {
  let client: BigQuery | undefined;
  return async (query) => {
    if (!config.BIGQUERY_PROJECT_ID) throw historyRequired();
    client ??= new BigQuery({
      projectId: config.BIGQUERY_PROJECT_ID,
      location: config.BIGQUERY_LOCATION,
    });
    try {
      const [job] = await client.createQueryJob({
        query: query.statement,
        params: normalizeWarehouseParameters(query.params, query.types),
        types: query.types,
        dryRun: true,
        useLegacySql: false,
        maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
        jobTimeoutMs: 10000,
        labels: { application: 'pos-rewrite', resource: 'public-order-history' },
      });
      return BigInt(
        z
          .object({ statistics: z.object({ query: z.object({ totalBytesProcessed: count }) }) })
          .parse(job.metadata).statistics.query.totalBytesProcessed,
      );
    } catch {
      throw new AppError(
        503,
        'ORDER_HISTORY_ESTIMATE_UNAVAILABLE',
        'The historical order query budget could not be verified.',
      );
    }
  };
}
const timestamp = z.iso.datetime({ offset: true });
const publication = z
  .object({
    generation_id: z.uuid(),
    contract_version: z.literal(orderHistoryContract),
    kind: z.enum(['store-day', 'order']),
    scope_id: positiveId,
    business_date: date.nullable(),
    source_complete: z.literal(true),
    source_snapshot_id: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
    source_snapshot_at: timestamp,
    source_cdc_watermark: timestamp,
    published_at: timestamp,
    source_rows: count,
    warehouse_rows: count,
    source_orders: count,
    warehouse_orders: count,
    source_stores: count,
    warehouse_stores: count,
    source_lines: count,
    warehouse_lines: count,
    source_hash: hash,
    warehouse_hash: hash,
    source_copy_hash: hash.nullable(),
    warehouse_copy_hash: hash.nullable(),
  })
  .strict();
type Publication = z.infer<typeof publication>;
function evidence(p: Publication): OrderHistoryEvidence {
  return {
    generationId: p.generation_id,
    sourceSnapshotId: p.source_snapshot_id,
    sourceSnapshotAt: p.source_snapshot_at,
    sourceCdcWatermark: p.source_cdc_watermark,
    publishedAt: p.published_at,
  };
}
function sameEvidence(a: Publication, b: Publication) {
  return JSON.stringify(evidence(a)) === JSON.stringify(evidence(b));
}
const compare = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const pointActual = z
  .object({
    headers: count,
    stores: count,
    lines: count,
    unique_stores: count,
    unique_lines: count,
  })
  .strict();
interface PointEnvelope {
  publications: Publication[];
  actual: z.infer<typeof pointActual>;
  headers: Pick<HistoryHeader, 'id' | 'customerId' | 'createdAt'>[];
  stores: HistoryStore[];
  lines: Pick<HistoryLine, 'id' | 'orderId' | 'productId'>[];
}
export function publicOrderHistory(
  config: Config,
  options: OrderHistoryOptions = readOrderHistoryOptions(),
  dependencies: {
    estimate?: OrderHistoryEstimator;
    query?: QueryReport;
    clock?: () => number;
  } = {},
): OrderHistoryPort {
  const estimate = dependencies.estimate ?? orderHistorySdkEstimator(config),
    query = dependencies.query ?? warehouseService(config).queryReport,
    clock = dependencies.clock ?? Date.now;
  function valid(p: Publication) {
    const now = clock(),
      snapshot = Date.parse(p.source_snapshot_at),
      watermark = Date.parse(p.source_cdc_watermark),
      published = Date.parse(p.published_at);
    if (
      p.source_rows !== p.warehouse_rows ||
      p.source_orders !== p.warehouse_orders ||
      p.source_stores !== p.warehouse_stores ||
      p.source_lines !== p.warehouse_lines ||
      p.source_hash !== p.warehouse_hash ||
      p.source_copy_hash !== p.warehouse_copy_hash ||
      (p.kind === 'order' && !p.source_copy_hash) ||
      (p.kind === 'store-day' && p.source_copy_hash !== null) ||
      snapshot > now + 5000 ||
      watermark > now + 5000 ||
      published > now + 5000 ||
      watermark < snapshot ||
      published < snapshot ||
      published + 5000 < watermark ||
      now - snapshot > options.ORDER_HISTORY_MAX_LAG_SECONDS * 1000
    )
      throw historyInvalid();
  }
  async function execute(
    statement: string,
    params: Record<string, unknown>,
    types: Record<string, string | string[]>,
    budget = { spent: 0n },
  ) {
    qualifiedOrderViews(options);
    const bytes = await estimate({ statement, params, types });
    if (bytes < 0n || budget.spent + bytes > BigInt(config.BIGQUERY_MAX_BYTES_BILLED))
      throw new AppError(
        503,
        'ORDER_HISTORY_PROJECTION_REQUIRED',
        'Historical orders need a qualified projection within the configured query budget.',
      );
    budget.spent += bytes;
    return query(statement, params, types, 'public-order-history');
  }
  function safeParsed<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw historyInvalid();
    return parsed.data;
  }
  async function point(orderId: string) {
    const budget = { spent: 0n },
      shard = Number(BigInt(orderId) % 1024n);
    const rows = await execute(
      historyPointPublicationSql(options),
      { contract: orderHistoryContract, order: orderId, shard },
      { contract: 'STRING', order: 'STRING', shard: 'INT64' },
      budget,
    );
    const [envelope] = safeParsed(
      z.array(z.object({ publications: z.array(publication).max(2) }).strict()).length(1),
      rows,
    );
    if (!envelope?.publications.length) throw historyRequired();
    if (envelope.publications.length !== 1) throw historyInvalid();
    const p = envelope.publications[0]!;
    valid(p);
    if (
      p.kind !== 'order' ||
      p.scope_id !== orderId ||
      !p.business_date ||
      BigInt(p.source_orders) > 1n ||
      BigInt(p.source_rows) !==
        BigInt(p.source_orders) + BigInt(p.source_stores) + BigInt(p.source_lines)
    )
      throw historyInvalid();
    if (
      BigInt(p.source_lines) > BigInt(options.ORDER_HISTORY_MAX_ORDER_LINES) ||
      BigInt(p.source_stores) > BigInt(options.ORDER_HISTORY_MAX_ORDER_LINES)
    )
      throw new AppError(
        422,
        'ORDER_HISTORY_TOO_LARGE',
        'This order exceeds the configured complete-detail bound.',
      );
    return {
      budget,
      publication: p,
      params: {
        contract: orderHistoryContract,
        order: orderId,
        shard,
        pointGeneration: p.generation_id,
        businessDate: p.business_date,
        snapshot: p.source_snapshot_id,
        take: options.ORDER_HISTORY_MAX_ORDER_LINES + 1,
      },
      types: {
        contract: 'STRING',
        order: 'STRING',
        shard: 'INT64',
        pointGeneration: 'STRING',
        businessDate: 'DATE',
        snapshot: 'STRING',
        take: 'INT64',
      },
    };
  }
  function verifyPoint(
    result: PointEnvelope | undefined,
    input: HistoryOrderInput,
    actualHash: string,
    minimal: boolean,
    expected: Publication,
    actualCopyHash?: string,
  ) {
    if (!result?.publications.length) throw historyRequired();
    if (result.publications.length !== 1) throw historyInvalid();
    const p = result.publications[0]!,
      orderId = input.orderId,
      source = copySource.parse(input.source),
      limit = options.ORDER_HISTORY_MAX_ORDER_LINES;
    valid(p);
    if (JSON.stringify(p) !== JSON.stringify(expected)) throw historyInvalid();
    if (
      p.kind !== 'order' ||
      p.scope_id !== orderId ||
      p.source_orders !== result.actual.headers ||
      p.source_stores !== result.actual.stores ||
      p.source_lines !== result.actual.lines ||
      result.actual.stores !== result.actual.unique_stores ||
      result.actual.lines !== result.actual.unique_lines ||
      BigInt(p.source_rows) !==
        BigInt(result.actual.headers) + BigInt(result.actual.stores) + BigInt(result.actual.lines)
    )
      throw historyInvalid();
    if (BigInt(result.actual.lines) > BigInt(limit) || BigInt(result.actual.stores) > BigInt(limit))
      throw new AppError(
        422,
        'ORDER_HISTORY_TOO_LARGE',
        'This order exceeds the configured complete-detail bound.',
      );
    if (
      result.headers.length !== Number(result.actual.headers) ||
      result.stores.length !== Number(result.actual.stores) ||
      result.lines.length !== Number(result.actual.lines) ||
      result.headers.length > 1 ||
      actualHash !== (minimal ? p.source_copy_hash : p.source_hash) ||
      (!minimal && actualCopyHash !== p.source_copy_hash)
    )
      throw historyInvalid();
    const h = result.headers[0];
    if (!h) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found in this selection.');
    if (
      h.id !== orderId ||
      h.createdAt.slice(0, 10) !== p.business_date ||
      result.stores.some(
        (s, index) =>
          s.orderId !== orderId || (index > 0 && compare(result.stores[index - 1]!.id, s.id) >= 0),
      ) ||
      result.lines.some(
        (l, index) =>
          l.orderId !== orderId || (index > 0 && compare(result.lines[index - 1]!.id, l.id) >= 0),
      )
    )
      throw historyInvalid();
    const range = input.range;
    if (
      (source.kind === 'store' && !result.stores.some((s) => s.storeId === source.storeId)) ||
      (source.kind === 'customer' && h.customerId !== source.customerId) ||
      (range && (h.createdAt < range.start || h.createdAt >= range.end)) ||
      (!range &&
        h.createdAt >= (input.cutoff ?? orderRange({}, config.BUSINESS_TIMEZONE, clock()).cutoff))
    )
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found in this selection.');
    return evidence(p);
  }
  const port: OrderHistoryPort = {
    async list(input) {
      positiveId.parse(input.storeId);
      z.number().int().min(1).max(100).parse(input.limit);
      if (input.generationId) z.uuid().parse(input.generationId);
      if (input.before) {
        positiveId.parse(input.before.orderId);
        count.parse(input.before.rowId);
      }
      const canonical = orderRange(
        { from: input.range.from, to: input.range.to, intent: input.range.intent },
        config.BUSINESS_TIMEZONE,
        clock(),
      );
      if (
        canonical.reader !== input.range.reader ||
        canonical.start !== input.range.start ||
        canonical.end !== input.range.end ||
        canonical.timeZone !== input.range.timeZone ||
        canonical.cutoff !== input.range.cutoff
      )
        throw new AppError(
          400,
          'INVALID_ORDER_DATE_RANGE',
          'Use a validated source business-date range.',
        );
      if (input.range.reader !== 'bigquery') throw historyInvalid();
      const rows = await execute(
        historyListSql(options),
        {
          contract: orderHistoryContract,
          store: input.storeId,
          from: input.range.from,
          to: input.range.to,
          start: input.range.start,
          end: input.range.end,
          shard: Number(BigInt(input.storeId) % 1024n),
          generation: input.generationId ?? '',
          beforeOrder: input.before?.orderId ?? '',
          beforeRow: input.before?.rowId ?? '',
          take: input.limit + 1,
        },
        {
          contract: 'STRING',
          store: 'STRING',
          from: 'DATE',
          to: 'DATE',
          start: 'DATETIME',
          end: 'DATETIME',
          shard: 'INT64',
          generation: 'STRING',
          beforeOrder: 'STRING',
          beforeRow: 'STRING',
          take: 'INT64',
        },
      );
      const [result] = safeParsed(
        z
          .array(
            z
              .object({
                publications: z.array(publication).max(124),
                actual: z
                  .array(
                    z
                      .object({
                        business_date: date,
                        rows: count,
                        orders: count,
                        unique_stores: count,
                        actual_hash: hash,
                      })
                      .strict(),
                  )
                  .max(62),
                page: z
                  .array(z.object({ header: historyHeader, store: historyStore }).strict())
                  .max(101),
              })
              .strict(),
          )
          .length(1),
        rows,
      );
      if (!result?.publications.length) throw historyRequired();
      const first = result.publications[0]!,
        seen = new Set<string>(),
        actual = new Map(result.actual.map((row) => [row.business_date, row]));
      if (actual.size !== result.actual.length) throw historyInvalid();
      for (const p of result.publications) {
        valid(p);
        if (
          p.kind !== 'store-day' ||
          p.scope_id !== input.storeId ||
          !p.business_date ||
          !sameEvidence(first, p) ||
          seen.has(p.business_date) ||
          (input.generationId && p.generation_id !== input.generationId)
        )
          throw historyInvalid();
        seen.add(p.business_date);
        const a = actual.get(p.business_date),
          rowCount = a?.rows ?? '0',
          orderCount = a?.orders ?? '0';
        if (
          p.source_rows !== rowCount ||
          p.source_stores !== rowCount ||
          p.source_orders !== orderCount ||
          p.source_lines !== '0' ||
          (a && a.unique_stores !== a.rows) ||
          p.source_hash !== (a?.actual_hash ?? historyRowsHash([]))
        )
          throw historyInvalid();
      }
      let day = Temporal.PlainDate.from(input.range.from),
        expected = 0;
      while (Temporal.PlainDate.compare(day, Temporal.PlainDate.from(input.range.to)) <= 0) {
        if (!seen.has(day.toString())) throw historyInvalid();
        expected++;
        day = day.add({ days: 1 });
      }
      if (seen.size !== expected || [...actual.keys()].some((day) => !seen.has(day)))
        throw historyInvalid();
      for (let index = 0; index < result.page.length; index++) {
        const current = result.page[index]!,
          previous = result.page[index - 1];
        if (
          current.store.storeId !== input.storeId ||
          current.store.orderId !== current.header.id ||
          current.header.createdAt < input.range.start ||
          current.header.createdAt >= input.range.end ||
          (previous &&
            (compare(previous.header.id, current.header.id) < 0 ||
              (previous.header.id === current.header.id &&
                compare(previous.store.id, current.store.id) <= 0))) ||
          (input.before &&
            (compare(current.header.id, input.before.orderId) > 0 ||
              (current.header.id === input.before.orderId &&
                compare(current.store.id, input.before.rowId) >= 0)))
        )
          throw historyInvalid();
      }
      return { rows: result.page, evidence: evidence(first) };
    },
    async order(input: HistoryOrderInput) {
      const source = copySource.parse(input.source),
        orderId = positiveId.parse(input.orderId),
        limit = options.ORDER_HISTORY_MAX_ORDER_LINES;
      const context = await point(orderId),
        rows = await execute(
          historyOrderSql(options),
          context.params,
          context.types,
          context.budget,
        );
      const [result] = safeParsed(
        z
          .array(
            z
              .object({
                publications: z.array(publication).max(2),
                actual: pointActual,
                headers: z.array(historyHeader).max(2),
                stores: z.array(historyStore).max(limit + 1),
                lines: z.array(historyLine).max(limit + 1),
              })
              .strict(),
          )
          .length(1),
        rows,
      );
      const proof = verifyPoint(
        result,
        { ...input, source, orderId },
        result ? historyOrderHash(result.headers, result.stores, result.lines) : '',
        false,
        context.publication,
        result ? historyCopyHash(result.headers, result.stores, result.lines) : '',
      );
      return {
        header: result!.headers[0]!,
        stores: result!.stores,
        lines: result!.lines,
        evidence: proof,
      };
    },
    async copyFacts(input) {
      sourceDate.parse(input.cutoff);
      if (input.cutoff !== orderRange({}, config.BUSINESS_TIMEZONE, clock()).cutoff)
        throw new AppError(
          400,
          'INVALID_ORDER_HISTORY_CUTOFF',
          'Use the current server business-day boundary.',
        );
      const source = copySource.parse(input.source),
        orderId = positiveId.parse(input.orderId),
        limit = options.ORDER_HISTORY_MAX_ORDER_LINES;
      const context = await point(orderId),
        rows = await execute(
          historyCopySql(options),
          context.params,
          context.types,
          context.budget,
        );
      const [result] = safeParsed(
        z
          .array(
            z
              .object({
                publications: z.array(publication).max(2),
                actual: pointActual,
                headers: z.array(copyHeader).max(2),
                stores: z.array(historyStore).max(limit + 1),
                lines: z.array(copyLine).max(limit + 1),
              })
              .strict(),
          )
          .length(1),
        rows,
      );
      const proof = verifyPoint(
        result,
        { source, orderId, cutoff: input.cutoff },
        result ? historyCopyHash(result.headers, result.stores, result.lines) : '',
        true,
        context.publication,
      );
      const h = result!.headers[0]!;
      return {
        orderId: h.id,
        sourceCustomerId: h.customerId,
        createdAt: h.createdAt,
        source,
        reader: 'bigquery',
        fetchedAt: new Date(clock()).toISOString(),
        generationId: proof.generationId,
        complete: true,
        lines: result!.lines.map((line) => ({ lineId: line.id, productId: line.productId })),
      };
    },
  };
  return port;
}
