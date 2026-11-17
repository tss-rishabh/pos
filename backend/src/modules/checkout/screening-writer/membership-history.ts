import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { AppError } from '../../../domain/errors.js';
import { operationHash } from '../crypto.js';
import { qualifiedCsvMembershipHistorySchema } from '../../legacy-order-imports/membership-profile/history.js';
import {
  csvMembershipSourceInstant,
  type CsvMembershipBigQueryOptions,
  type CsvMembershipHistoryStatement,
  type CsvMembershipHistoryQueryPort,
  csvMembershipHistorySdk,
  readCsvMembershipBigQueryOptions,
  csvMembershipBigQueryContract,
} from '../../legacy-order-imports/membership-profile/bigquery.js';

export const publicMemberHistoryContract = 'pos-public-screening-membership-history-v1';
export const membershipGenerationContract = 'pos-membership-history-generation-v1';
export const membershipGenerationPublicationContract = 'pos-membership-history-publication-v1';
export const publicMembershipBigQueryContract = 'pos-public-screening-membership-bigquery-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  count = z
    .string()
    .regex(/^(?:0|[1-9]\d{0,19})$/)
    .refine((value) => BigInt(value) <= 18446744073709551615n),
  wall = z
    .string()
    .regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
    .refine((value) => {
      try {
        Temporal.PlainDateTime.from(value.replace(' ', 'T'));
        return true;
      } catch {
        return false;
      }
    }),
  zone = z.string().min(1).max(128),
  schemaName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
export const publicMembershipHeadSchema = z
  .object({
    contract: z.literal('pos-membership-history-head-v1'),
    origin: z.object({ schema: schemaName, serverUuid: z.uuid() }).strict(),
    revision: count,
    writersHash: hash,
  })
  .strict();
export const publicMembershipHistoryRequestSchema = z
  .object({
    contract: z.literal(publicMemberHistoryContract),
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    customerId: identifier,
    requestHash: hash,
    cartHash: hash,
    configurationHash: hash,
    sourceTimeZone: zone,
    asOf: wall,
    cutoff: wall,
  })
  .strict()
  .refine((value) => cutoff(value.asOf) === value.cutoff);
const selectionSchema = qualifiedCsvMembershipHistorySchema.pick({
  lastDeliveredOrder: true,
  recentDeliveredOrders: true,
});
export const membershipGenerationSchema = z
  .object({
    contract: z.literal(membershipGenerationContract),
    generationId: hash,
    customerId: identifier,
    sourceTimeZone: zone,
    asOf: wall,
    cutoff: wall,
    configurationHash: hash,
    head: publicMembershipHeadSchema,
    sourceOrderCount: count,
    sourceSelectedOrderCount: count,
    sourceLineCount: count,
    selection: selectionSchema,
    selectionHash: hash,
    capturedAt: z.number().int().positive().safe(),
    signature: hash,
  })
  .strict()
  .refine((value) => cutoff(value.asOf) === value.cutoff);
export const membershipGenerationPublicationSchema = z
  .object({
    contract: z.literal(membershipGenerationPublicationContract),
    generationId: hash,
    sourceCaptureHash: hash,
    warehouseOrderCount: count,
    warehouseSelectedOrderCount: count,
    warehouseLineCount: count,
    warehouseSelectionHash: hash,
    publishedAt: z.number().int().positive().safe(),
    signature: hash,
  })
  .strict();
export const publicMembershipHistorySchema = z
  .object({
    contract: z.literal(publicMemberHistoryContract),
    scope: publicMembershipHistoryRequestSchema,
    head: publicMembershipHeadSchema,
    generationId: hash,
    sourceCaptureHash: hash,
    publicationHash: hash,
    reader: z.literal('bigquery'),
    complete: z.literal(true),
    fetchedAt: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
    selection: selectionSchema,
    signature: hash,
  })
  .strict();
export type PublicMembershipHistoryRequest = z.infer<typeof publicMembershipHistoryRequestSchema>;
export type PublicMembershipHead = z.infer<typeof publicMembershipHeadSchema>;
export type MembershipGeneration = z.infer<typeof membershipGenerationSchema>;
export type MembershipGenerationPublication = z.infer<typeof membershipGenerationPublicationSchema>;
export type PublicMembershipHistory = z.infer<typeof publicMembershipHistorySchema>;
export interface PublicMembershipHistoryPort {
  read(
    request: PublicMembershipHistoryRequest,
    head: PublicMembershipHead,
    options: { signal: AbortSignal; expiresAt: number },
  ): Promise<PublicMembershipHistory>;
}
export const publicMembershipHistoryError = () =>
  new AppError(
    503,
    'SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED',
    'Complete membership history and its current source witness are required before creating this order.',
  );
/** Separate publication resources from the older operation-scoped CSV view.
 * Only the read-only SDK transport/budgets are reused; public generations have
 * their own source/publication/document contracts and no CSV authority. */
export function readPublicMembershipBigQueryOptions(
  env: NodeJS.ProcessEnv = process.env,
): CsvMembershipBigQueryOptions {
  if (
    env.PUBLIC_SCREENING_MEMBERSHIP_BIGQUERY_CONTRACT &&
    env.PUBLIC_SCREENING_MEMBERSHIP_BIGQUERY_CONTRACT !== publicMembershipBigQueryContract
  )
    throw publicMembershipHistoryError();
  return readCsvMembershipBigQueryOptions({
    CSV_MEMBERSHIP_BIGQUERY_CONTRACT: env.PUBLIC_SCREENING_MEMBERSHIP_BIGQUERY_CONTRACT
      ? csvMembershipBigQueryContract
      : undefined,
    BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW: env.BQ_PUBLIC_SCREENING_MEMBERSHIP_PUBLICATIONS_VIEW,
    BQ_CSV_MEMBERSHIP_ORDERS_VIEW: env.BQ_PUBLIC_SCREENING_MEMBERSHIP_ORDERS_VIEW,
    BQ_CSV_MEMBERSHIP_LINES_VIEW: env.BQ_PUBLIC_SCREENING_MEMBERSHIP_LINES_VIEW,
    CSV_MEMBERSHIP_SOURCE_TIMEZONE: env.PUBLIC_SCREENING_MEMBERSHIP_SOURCE_TIMEZONE,
    CSV_MEMBERSHIP_MAX_BYTES_BILLED: env.PUBLIC_SCREENING_MEMBERSHIP_MAX_BYTES_BILLED,
    CSV_MEMBERSHIP_QUERY_TIMEOUT_MS: env.PUBLIC_SCREENING_MEMBERSHIP_QUERY_TIMEOUT_MS,
    CSV_MEMBERSHIP_MAX_ORDERS: env.PUBLIC_SCREENING_MEMBERSHIP_MAX_ORDERS,
    CSV_MEMBERSHIP_MAX_LINES: env.PUBLIC_SCREENING_MEMBERSHIP_MAX_LINES,
    CSV_MEMBERSHIP_MAX_LAG_SECONDS: env.PUBLIC_SCREENING_MEMBERSHIP_MAX_LAG_SECONDS,
  });
}
export function assertMembershipHistoryKeys(...keys: string[]) {
  if (new Set(keys).size !== keys.length || keys.some((key) => !/^[!-~]{32,4096}$/.test(key)))
    throw publicMembershipHistoryError();
}
export function cutoff(asOf: string) {
  return Temporal.PlainDateTime.from(asOf.replace(' ', 'T'))
    .subtract({ days: 45 })
    .toString({ smallestUnit: 'second' })
    .replace('T', ' ');
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(([name, item]) => [name, canonical(item)]),
    );
  return value;
}
export function membershipHistoryDigest(purpose: string, value: unknown, key: string) {
  if (!/^[!-~]{32,4096}$/.test(key)) throw publicMembershipHistoryError();
  return operationHash('public-screening.membership-history.' + purpose + '.v1', value, key);
}
export function membershipSelectionHash(selection: z.infer<typeof selectionSchema>) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(selection)))
    .digest('hex');
}
export function validateMembershipSelection(
  selection: unknown,
  asOf: string,
  since: string,
  memberIds: readonly string[],
) {
  const value = selectionSchema.parse(selection),
    recent = value.recentDeliveredOrders,
    last = value.lastDeliveredOrder;
  const members = new Set(memberIds),
    all = [...(last ? [last] : []), ...recent];
  if (
    new Set(recent.map((order) => order.id)).size !== recent.length ||
    recent.some(
      (order, index) =>
        order.createdAt <= since ||
        order.createdAt > asOf ||
        (index > 0 && recent[index - 1]!.createdAt <= order.createdAt),
    ) ||
    (recent.length && JSON.stringify(last) !== JSON.stringify(recent[0])) ||
    (last && (last.createdAt > asOf || (last.createdAt > since && !recent.length))) ||
    all.reduce((sum, order) => sum + order.lines.length, 0) > 20000 ||
    Buffer.byteLength(JSON.stringify(value)) > 900000 ||
    all.some(
      (order) =>
        new Set(order.lines.map((line) => line.lineId)).size !== order.lines.length ||
        new Set(
          order.lines
            .filter((line) => !members.has(line.productId))
            .map((line) => line.isExclusiveOrder),
        ).size > 1,
    )
  )
    throw publicMembershipHistoryError();
  return value;
}
/** A complete generation is independent of any checkout/operation. Its native
 * witness must be unchanged at the new literal execution point. Recompute the
 * rolling predicate from primitive dates, never reuse a same-day total. */
export function bindPublicMembershipGeneration(input: {
  request: PublicMembershipHistoryRequest;
  head: PublicMembershipHead;
  generation: unknown;
  publication: unknown;
  warehouseSelection: unknown;
  memberIds: readonly string[];
  sourceKey: string;
  publicationKey: string;
  historyKey: string;
  expiresAt: number;
  now: number;
  maximumAgeMs?: number;
}): PublicMembershipHistory {
  const r = publicMembershipHistoryRequestSchema.parse(input.request),
    h = publicMembershipHeadSchema.parse(input.head),
    g = membershipGenerationSchema.parse(input.generation),
    p = membershipGenerationPublicationSchema.parse(input.publication),
    selected = validateMembershipSelection(g.selection, g.asOf, g.cutoff, input.memberIds),
    warehouse = validateMembershipSelection(
      input.warehouseSelection,
      g.asOf,
      g.cutoff,
      input.memberIds,
    ),
    { signature: sourceSignature, ...sourceBody } = g,
    { signature: publicationSignature, ...publicationBody } = p,
    sourceAt = csvMembershipSourceInstant(g.asOf, g.sourceTimeZone),
    executionAt = csvMembershipSourceInstant(r.asOf, r.sourceTimeZone),
    keys = [input.sourceKey, input.publicationKey, input.historyKey],
    maximumAge = input.maximumAgeMs ?? 60000;
  const uniqueOrders = [
    ...new Map(
      [
        ...(selected.lastDeliveredOrder ? [selected.lastDeliveredOrder] : []),
        ...selected.recentDeliveredOrders,
      ].map((row) => [row.id, row]),
    ).values(),
  ];
  if (
    new Set(keys).size !== 3 ||
    !Number.isSafeInteger(maximumAge) ||
    maximumAge < 1000 ||
    maximumAge > 60000 ||
    keys.some((key) => !/^[!-~]{32,4096}$/.test(key)) ||
    sourceSignature !== membershipHistoryDigest('generation', sourceBody, input.sourceKey) ||
    publicationSignature !==
      membershipHistoryDigest('publication', publicationBody, input.publicationKey) ||
    p.sourceCaptureHash !== sourceSignature ||
    p.generationId !== g.generationId ||
    g.customerId !== r.customerId ||
    g.configurationHash !== r.configurationHash ||
    g.sourceTimeZone !== r.sourceTimeZone ||
    JSON.stringify(g.head) !== JSON.stringify(h) ||
    g.asOf > r.asOf ||
    g.cutoff > r.cutoff ||
    !Number.isSafeInteger(input.now) ||
    input.now < executionAt ||
    input.now < p.publishedAt ||
    p.publishedAt < g.capturedAt ||
    g.capturedAt < sourceAt ||
    g.capturedAt - sourceAt >= 1000 ||
    input.now - sourceAt >= maximumAge ||
    membershipSelectionHash(selected) !== g.selectionHash ||
    membershipSelectionHash(warehouse) !== g.selectionHash ||
    p.warehouseSelectionHash !== g.selectionHash ||
    p.warehouseOrderCount !== g.sourceOrderCount ||
    p.warehouseSelectedOrderCount !== g.sourceSelectedOrderCount ||
    p.warehouseLineCount !== g.sourceLineCount ||
    BigInt(g.sourceSelectedOrderCount) !== BigInt(uniqueOrders.length) ||
    BigInt(g.sourceLineCount) !==
      BigInt(uniqueOrders.reduce((sum, row) => sum + row.lines.length, 0)) ||
    BigInt(g.sourceOrderCount) < BigInt(uniqueOrders.length)
  )
    throw publicMembershipHistoryError();
  const selection = validateMembershipSelection(
    {
      lastDeliveredOrder: selected.lastDeliveredOrder,
      recentDeliveredOrders: selected.recentDeliveredOrders.filter(
        (order) => order.createdAt > r.cutoff,
      ),
    },
    r.asOf,
    r.cutoff,
    input.memberIds,
  );
  const body = {
    contract: publicMemberHistoryContract,
    scope: r,
    head: h,
    generationId: g.generationId,
    sourceCaptureHash: sourceSignature,
    publicationHash: publicationSignature,
    reader: 'bigquery' as const,
    complete: true as const,
    fetchedAt: input.now,
    expiresAt: Math.min(input.expiresAt, sourceAt + maximumAge, executionAt + maximumAge),
    selection,
  };
  if (body.expiresAt <= input.now) throw publicMembershipHistoryError();
  return Object.freeze(
    publicMembershipHistorySchema.parse({
      ...body,
      signature: membershipHistoryDigest('document', body, input.historyKey),
    }),
  );
}
export function publicMembershipHistorySql(
  options: CsvMembershipBigQueryOptions,
  request: PublicMembershipHistoryRequest,
): CsvMembershipHistoryStatement {
  const view = options.BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW;
  if (!view || !/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/.test(view))
    throw publicMembershipHistoryError();
  return {
    statement: `WITH eligible AS (SELECT generation_id,source_capture,publication,warehouse_selection,as_of FROM \`${view}\`
WHERE scope_shard=@shard AND contract=@contract AND customer_id=@customer
AND source_time_zone=@zone AND configuration_hash=@configuration
AND as_of<=@asOf AND cutoff<=@cutoff AND as_of>=DATETIME_SUB(@asOf,INTERVAL 60 SECOND)
), generations AS (SELECT generation_id,source_capture,publication,warehouse_selection FROM eligible
WHERE as_of=(SELECT MAX(as_of) FROM eligible) LIMIT 2)
SELECT TO_JSON_STRING(STRUCT(ARRAY(SELECT AS STRUCT generation_id AS generationId,
source_capture AS sourceCapture,publication,warehouse_selection AS warehouseSelection FROM generations) AS generations)) AS document`,
    params: {
      shard: Number(BigInt(request.customerId) % 1024n),
      contract: membershipGenerationPublicationContract,
      customer: request.customerId,
      zone: request.sourceTimeZone,
      configuration: request.configurationHash,
      asOf: request.asOf,
      cutoff: request.cutoff,
    },
    types: {
      shard: 'INT64',
      contract: 'STRING',
      customer: 'STRING',
      zone: 'STRING',
      configuration: 'STRING',
      asOf: 'DATETIME',
      cutoff: 'DATETIME',
    },
  };
}
/** SDK-only runtime consumer. It cannot invoke a native capture/publisher. */
export function publicMembershipBigQueryHistory(
  options: CsvMembershipBigQueryOptions,
  authority: {
    memberIds: readonly string[];
    sourceKey: string;
    publicationKey: string;
    historyKey: string;
  },
  dependencies: { query?: CsvMembershipHistoryQueryPort; clock?: () => number } = {},
): PublicMembershipHistoryPort {
  const clock = dependencies.clock ?? Date.now;
  return {
    async read(request, head, call) {
      try {
        assertMembershipHistoryKeys(
          authority.sourceKey,
          authority.publicationKey,
          authority.historyKey,
        );
        if (!authority.memberIds.length) throw publicMembershipHistoryError();
        request = publicMembershipHistoryRequestSchema.parse(request);
        head = publicMembershipHeadSchema.parse(head);
        const statement = publicMembershipHistorySql(options, request),
          query =
            dependencies.query ??
            csvMembershipHistorySdk(options, undefined, (input) => {
              if (JSON.stringify(input) !== JSON.stringify(statement))
                throw publicMembershipHistoryError();
              return statement;
            });
        const signal = AbortSignal.any([
          call.signal,
          AbortSignal.timeout(options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS),
        ]);
        signal.throwIfAborted();
        const bytes = await query.estimate(statement, signal);
        if (bytes < 0n || bytes > BigInt(options.CSV_MEMBERSHIP_MAX_BYTES_BILLED))
          throw publicMembershipHistoryError();
        const raw = await query.execute(statement, signal);
        signal.throwIfAborted();
        const wire = z
          .array(z.object({ document: z.string().max(2000000) }).strict())
          .length(1)
          .parse(raw)[0]!;
        if (Buffer.byteLength(wire.document) > 2000000) throw publicMembershipHistoryError();
        const decoded: unknown = JSON.parse(wire.document);
        const data = z
          .object({
            generations: z
              .array(
                z
                  .object({
                    generationId: hash,
                    sourceCapture: z.unknown(),
                    publication: z.unknown(),
                    warehouseSelection: z.unknown(),
                  })
                  .strict(),
              )
              .max(2),
          })
          .strict()
          .parse(decoded);
        // Duplicate eligible rows are an integrity error; never choose an
        // arbitrary first generation when its native witness is ambiguous.
        if (!data.generations.length)
          throw new AppError(
            503,
            'SCREENING_MEMBERSHIP_GENERATION_NOT_FOUND',
            'A complete membership generation must be published before this sale can continue.',
          );
        if (data.generations.length !== 1) throw publicMembershipHistoryError();
        const record = data.generations[0]!;
        const value = bindPublicMembershipGeneration({
          request,
          head,
          generation: record.sourceCapture,
          publication: record.publication,
          warehouseSelection: record.warehouseSelection,
          ...authority,
          expiresAt: call.expiresAt,
          now: clock(),
          maximumAgeMs: options.CSV_MEMBERSHIP_MAX_LAG_SECONDS * 1000,
        });
        if (value.generationId !== record.generationId) throw publicMembershipHistoryError();
        return value;
      } catch (error) {
        if (error instanceof AppError && error.code === 'SCREENING_MEMBERSHIP_GENERATION_NOT_FOUND')
          throw error;
        throw publicMembershipHistoryError();
      }
    },
  };
}
