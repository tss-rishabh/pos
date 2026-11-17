import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { bigint, datetime, int, mysqlTable, tinyint } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { readMembershipSourceSnapshot } from '../../legacy-order-imports/membership-profile/publication-transaction.js';
import { membershipHistoryWriters } from './membership-history-writers.js';
import {
  membershipGenerationContract,
  membershipGenerationPublicationContract,
  membershipGenerationSchema,
  membershipGenerationPublicationSchema,
  publicMembershipHeadSchema,
  membershipHistoryDigest,
  membershipSelectionHash,
  publicMembershipHistoryError,
  assertMembershipHistoryKeys,
  cutoff,
  validateMembershipSelection,
  type MembershipGeneration,
  type MembershipGenerationPublication,
} from './membership-history.js';
import {
  csvMembershipHistorySdk,
  type CsvMembershipBigQueryOptions,
  type CsvMembershipHistoryQueryPort,
} from '../../legacy-order-imports/membership-profile/bigquery.js';

const header = mysqlTable('orders', {
  id: bigint('id', { mode: 'bigint' }).notNull(),
  customerId: bigint('user_id', { mode: 'bigint' }).notNull(),
  method: int('payment_method').notNull(),
  status: int('order_status').notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
const hp = mysqlTable('has_products', {
  id: bigint('id', { mode: 'bigint' }).notNull(),
  order: bigint('order_id', { mode: 'bigint' }).notNull(),
  product: bigint('prod_id', { mode: 'bigint' }).notNull(),
  exclusive: tinyint('is_exclusive_order').notNull(),
});
const heads = mysqlTable('pos_rewrite_membership_history_heads', {
  customer: bigint('customer_id', { mode: 'bigint' }).primaryKey(),
  revision: bigint('revision', { mode: 'bigint', unsigned: true }).notNull(),
});
const count = z.string().regex(/^(?:0|[1-9]\d{0,19})$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const optionsSchema = z.object({
  contract: z.literal('pos-membership-history-native-publication-v1').optional(),
  sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  sourceServerUuid: z.uuid(),
  triggerDefiner: z.string().regex(/^[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}$/),
  sourceTimeZone: z.string().min(1).max(128),
  timeoutMs: z.number().int().min(100).max(10000).default(8000),
  maxOrders: z.number().int().min(1).max(5000).default(1000),
  maxLines: z.number().int().min(1).max(10000).default(10000),
});
function records<T>(raw: unknown, schema: z.ZodType<T>, maximum: number): T[] {
  return z.tuple([z.array(schema).max(maximum), z.unknown()]).parse(raw)[0];
}
/** Publication infrastructure ONLY. It is intentionally not a runtime history
 * port, takes no financial transaction, and exposes no read() fallback. Writer
 * origin is checked inside its explicit READ ONLY consistent snapshot. */
export function nativeMembershipGenerationPublisher(
  db: Databases,
  suppliedOptions: z.input<typeof optionsSchema>,
  authority: { sourceKey: string; memberIds: readonly string[] },
) {
  const options = optionsSchema.parse(suppliedOptions);
  assertMembershipHistoryKeys(authority.sourceKey);
  if (!authority.memberIds.length || authority.memberIds.some((id) => !/^[1-9]\d{0,18}$/.test(id)))
    throw publicMembershipHistoryError();
  return {
    async capture(
      input: { customerId: string; generationId: string; configurationHash: string },
      call: { signal?: AbortSignal } = {},
    ): Promise<MembershipGeneration> {
      const customer = z
        .string()
        .regex(/^[1-9]\d{0,18}$/)
        .parse(input.customerId);
      hash.parse(input.generationId);
      hash.parse(input.configurationHash);
      if (options.contract !== 'pos-membership-history-native-publication-v1')
        throw publicMembershipHistoryError();
      const abort = new AbortController(),
        stop = () => abort.abort();
      call.signal?.addEventListener('abort', stop, { once: true });
      if (call.signal?.aborted) stop();
      const timer = setTimeout(stop, options.timeoutMs);
      try {
        return await readMembershipSourceSnapshot(
          db.get('writer').$client,
          async (tx) => {
            const [identity] = records(
              await tx.execute(sql`SELECT DATABASE() AS schemaName,@@GLOBAL.server_uuid AS serverUuid,
@@GLOBAL.read_only AS reader,@@GLOBAL.super_read_only AS superReader,
DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') AS capturedAt`),
              z
                .object({
                  schemaName: z.literal(options.sourceSchema),
                  serverUuid: z.literal(options.sourceServerUuid),
                  reader: z.union([z.literal(0), z.literal('0')]),
                  superReader: z.union([z.literal(0), z.literal('0')]),
                  capturedAt: z.string(),
                })
                .strict(),
              1,
            );
            if (!identity) throw publicMembershipHistoryError();
            const instant = Temporal.Instant.from(identity.capturedAt),
              capturedAt = instant.epochMilliseconds,
              asOf = instant
                .toZonedDateTimeISO(options.sourceTimeZone)
                .toPlainDateTime()
                .toString({ smallestUnit: 'second' })
                .replace('T', ' '),
              since = cutoff(asOf);
            const [head] = await tx
              .select({ revision: heads.revision })
              .from(heads)
              .where(eq(heads.customer, BigInt(customer)))
              .limit(1);
            if (!head) throw publicMembershipHistoryError();
            await tx.execute(sql`SELECT id FROM orders LIMIT 0`);
            await tx.execute(sql`SELECT id FROM has_products LIMIT 0`);
            const definitions = records(
              await tx.execute(sql`SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS tableName,
EVENT_MANIPULATION AS event,ACTION_TIMING AS timing,LOWER(SHA2(ACTION_STATEMENT,256)) AS hash,SQL_MODE AS sqlMode,DEFINER AS definer
FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN (${sql.join(
                membershipHistoryWriters.definitions.map((value) => sql`${value.name}`),
                sql`, `,
              )})`),
              z
                .object({
                  name: z.string(),
                  tableName: z.string(),
                  event: z.string(),
                  timing: z.string(),
                  hash,
                  sqlMode: z.string(),
                  definer: z.literal(options.triggerDefiner),
                })
                .strict(),
              7,
            );
            if (
              definitions.length !== 7 ||
              membershipHistoryWriters.definitions.some((expected) => {
                const actual = definitions.find((row) => row.name === expected.name);
                return (
                  !actual ||
                  ['name', 'tableName', 'event', 'timing', 'hash'].some(
                    (field) =>
                      actual[field as keyof typeof actual] !==
                      expected[field as keyof typeof expected],
                  ) ||
                  !actual.sqlMode
                    .split(',')
                    .some((mode) => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(mode))
                );
              })
            )
              throw publicMembershipHistoryError();
            const selectedCustomer = and(
              eq(header.customerId, BigInt(customer)),
              eq(header.status, 3),
            );
            const [total] = await tx
              .select({
                count: sql<string>`CAST(COUNT(*) AS CHAR)`,
                invalid: sql<string>`CAST(COUNT(CASE WHEN ${header.id}<=0 OR ${header.createdAt} IS NULL OR YEAR(${header.createdAt})=0 OR MICROSECOND(${header.createdAt})<>0 OR ${header.method}<0 OR ${header.method}>32767 THEN 1 END) AS CHAR)`,
                latest: sql<string | null>`MAX(${header.createdAt})`,
              })
              .from(header)
              .where(selectedCustomer);
            if (!total || !count.safeParse(total.count).success || total.invalid !== '0')
              throw publicMembershipHistoryError();
            const fields = {
              id: header.id,
              paymentMethod: header.method,
              createdAt: header.createdAt,
            };
            const latest = await tx
              .select(fields)
              .from(header)
              .where(selectedCustomer)
              .orderBy(desc(header.createdAt))
              .limit(2);
            if (latest.length === 2 && latest[0]!.createdAt === latest[1]!.createdAt)
              throw publicMembershipHistoryError();
            const recent = await tx
              .select(fields)
              .from(header)
              .where(and(selectedCustomer, gt(header.createdAt, since)))
              .orderBy(desc(header.createdAt))
              .limit(options.maxOrders + 1);
            if (recent.length > options.maxOrders) throw publicMembershipHistoryError();
            const all = [
              ...new Map(
                [...latest.slice(0, 1), ...recent].map((row) => [String(row.id), row]),
              ).values(),
            ];
            const lines = all.length
              ? await tx
                  .select({
                    id: hp.id,
                    order: hp.order,
                    product: hp.product,
                    exclusive: hp.exclusive,
                  })
                  .from(hp)
                  .where(
                    inArray(
                      hp.order,
                      all.map((row) => row.id),
                    ),
                  )
                  .orderBy(asc(hp.order), asc(hp.id))
                  .limit(options.maxLines + 1)
              : [];
            if (lines.length > options.maxLines) throw publicMembershipHistoryError();
            const order = (row: (typeof all)[number]) => ({
              id: String(row.id),
              paymentMethod: row.paymentMethod,
              createdAt: row.createdAt,
              lines: lines
                .filter((line) => line.order === row.id)
                .map((line) => ({
                  lineId: String(line.id),
                  productId: String(line.product),
                  isExclusiveOrder: line.exclusive,
                })),
            });
            const selection = validateMembershipSelection(
              {
                lastDeliveredOrder: latest[0] ? order(latest[0]) : null,
                recentDeliveredOrders: recent.map(order),
              },
              asOf,
              since,
              authority.memberIds,
            );
            const body = {
              contract: membershipGenerationContract,
              generationId: input.generationId,
              customerId: customer,
              sourceTimeZone: options.sourceTimeZone,
              asOf,
              cutoff: since,
              configurationHash: input.configurationHash,
              head: publicMembershipHeadSchema.parse({
                contract: membershipHistoryWriters.contract,
                origin: { schema: identity.schemaName, serverUuid: identity.serverUuid },
                revision: String(head.revision),
                writersHash: createHash('sha256')
                  .update(membershipHistoryWriters.writersHash + '\n' + options.triggerDefiner)
                  .digest('hex'),
              }),
              sourceOrderCount: total.count,
              sourceSelectedOrderCount: String(all.length),
              sourceLineCount: String(lines.length),
              selection,
              selectionHash: membershipSelectionHash(selection),
              capturedAt,
            };
            return membershipGenerationSchema.parse({
              ...body,
              signature: membershipHistoryDigest('generation', body, authority.sourceKey),
            });
          },
          { signal: abort.signal },
        );
      } catch {
        throw publicMembershipHistoryError();
      } finally {
        clearTimeout(timer);
        call.signal?.removeEventListener('abort', stop);
      }
    },
  };
}
export interface MembershipWarehouseGenerationPort {
  read(
    source: MembershipGeneration,
    options: { signal: AbortSignal },
  ): Promise<{
    orderCount: string;
    selectedOrderCount: string;
    lineCount: string;
    invalidRows: string;
    duplicateIds: string;
    latestTies: string;
    selection: unknown;
  }>;
}
/** Bounded independent warehouse facts for a publisher. It never uploads or
 * mutates a publication, and cannot borrow the source selection as its answer. */
export function warehouseMembershipGenerationReader(
  options: CsvMembershipBigQueryOptions,
  dependencies: { query?: CsvMembershipHistoryQueryPort; unmaterialized?: boolean } = {},
): MembershipWarehouseGenerationPort {
  return {
    async read(source, call) {
      try {
        const orders = options.BQ_CSV_MEMBERSHIP_ORDERS_VIEW,
          lines = options.BQ_CSV_MEMBERSHIP_LINES_VIEW;
        if (
          !orders ||
          !lines ||
          orders === lines ||
          [orders, lines].some(
            (name) =>
              !/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/.test(name),
          )
        )
          throw publicMembershipHistoryError();
        const sourceScope = dependencies.unmaterialized
          ? 'source_schema=@sourceSchema AND source_server_uuid=@sourceServer'
          : 'generation_id=@generation';
        const statement = {
          statement: `WITH delivered AS (SELECT * FROM \`${orders}\`
WHERE scope_shard=@shard AND customer_id=@customer AND ${sourceScope} AND order_status=3),
selected AS (SELECT * FROM delivered WHERE created_at>@cutoff OR created_at=(SELECT MAX(created_at) FROM delivered)),
bounded_orders AS (SELECT * FROM selected ORDER BY created_at DESC,SAFE_CAST(order_id AS INT64) DESC LIMIT @orders),
selected_lines AS (SELECT * FROM \`${lines}\` WHERE scope_shard=@shard AND ${sourceScope}
AND order_id IN (SELECT order_id FROM bounded_orders))
SELECT TO_JSON_STRING(STRUCT(
CAST((SELECT COUNT(*) FROM delivered) AS STRING) AS orderCount,
CAST((SELECT COUNT(*) FROM selected) AS STRING) AS selectedOrderCount,
CAST((SELECT COUNT(*) FROM selected_lines) AS STRING) AS lineCount,
CAST((SELECT COUNT(*) FROM delivered WHERE SAFE_CAST(order_id AS INT64) IS NULL OR SAFE_CAST(order_id AS INT64)<=0
OR created_at IS NULL OR created_at!=DATETIME_TRUNC(created_at,SECOND)
OR payment_method IS NULL OR payment_method<0 OR payment_method>32767)
+(SELECT COUNT(*) FROM selected_lines WHERE customer_id IS NULL OR customer_id!=@customer) AS STRING) AS invalidRows,
CAST((SELECT COUNT(*)-COUNT(DISTINCT order_id) FROM delivered)
+(SELECT COUNT(*)-COUNT(DISTINCT line_id) FROM selected_lines) AS STRING) AS duplicateIds,
CAST((SELECT COUNT(*) FROM delivered WHERE created_at=(SELECT MAX(created_at) FROM delivered)) AS STRING) AS latestTies,
ARRAY(SELECT AS STRUCT SUBSTR(order_id,1,20) AS id,payment_method AS paymentMethod,
FORMAT_DATETIME('%F %T',created_at) AS createdAt FROM bounded_orders
ORDER BY created_at DESC,SAFE_CAST(order_id AS INT64) DESC) AS orders,
ARRAY(SELECT AS STRUCT SUBSTR(order_id,1,20) AS orderId,SUBSTR(line_id,1,20) AS lineId,
SUBSTR(product_id,1,20) AS productId,is_exclusive_order AS isExclusiveOrder FROM selected_lines
ORDER BY SAFE_CAST(order_id AS INT64),SAFE_CAST(line_id AS INT64) LIMIT @lines) AS lines)) AS document`,
          params: {
            shard: Number(BigInt(source.customerId) % 1024n),
            customer: source.customerId,
            ...(dependencies.unmaterialized
              ? {
                  sourceSchema: source.head.origin.schema,
                  sourceServer: source.head.origin.serverUuid,
                }
              : { generation: source.generationId }),
            asOf: source.asOf,
            cutoff: source.cutoff,
            orders: options.CSV_MEMBERSHIP_MAX_ORDERS + 1,
            lines: options.CSV_MEMBERSHIP_MAX_LINES + 1,
          },
          types: {
            shard: 'INT64',
            customer: 'STRING',
            ...(dependencies.unmaterialized
              ? { sourceSchema: 'STRING', sourceServer: 'STRING' }
              : { generation: 'STRING' }),
            asOf: 'DATETIME',
            cutoff: 'DATETIME',
            orders: 'INT64',
            lines: 'INT64',
          },
        };
        const query =
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
        const id = z.string().regex(/^[1-9]\d{0,18}$/),
          data = z
            .object({
              orderCount: count,
              selectedOrderCount: count,
              lineCount: count,
              invalidRows: count,
              duplicateIds: count,
              latestTies: count,
              orders: z
                .array(
                  z
                    .object({
                      id,
                      paymentMethod: z.number().int().min(0).max(32767),
                      createdAt: z.string(),
                    })
                    .strict(),
                )
                .max(options.CSV_MEMBERSHIP_MAX_ORDERS),
              lines: z
                .array(
                  z
                    .object({
                      orderId: id,
                      lineId: id,
                      productId: id,
                      isExclusiveOrder: z.union([z.literal(0), z.literal(1)]),
                    })
                    .strict(),
                )
                .max(options.CSV_MEMBERSHIP_MAX_LINES),
            })
            .strict()
            .parse(JSON.parse(wire.document) as unknown);
        if (
          BigInt(data.selectedOrderCount) !== BigInt(data.orders.length) ||
          BigInt(data.lineCount) !== BigInt(data.lines.length) ||
          data.lines.some((line) => !data.orders.some((order) => order.id === line.orderId))
        )
          throw publicMembershipHistoryError();
        const projected = data.orders.map((order) => ({
          ...order,
          lines: data.lines
            .filter((line) => line.orderId === order.id)
            .map(({ orderId: _order, ...line }) => line),
        }));
        return {
          orderCount: data.orderCount,
          selectedOrderCount: data.selectedOrderCount,
          lineCount: data.lineCount,
          invalidRows: data.invalidRows,
          duplicateIds: data.duplicateIds,
          latestTies: data.latestTies,
          selection: {
            lastDeliveredOrder: projected[0] ?? null,
            recentDeliveredOrders: projected.filter((order) => order.createdAt > source.cutoff),
          },
        };
      } catch {
        throw publicMembershipHistoryError();
      }
    },
  };
}
/** The warehouse reducer is independent of the source capture. A caller flag,
 * CDC watermark or a second copy of the source hash cannot issue this seal. */
export async function publishMembershipGeneration(
  supplied: unknown,
  warehouse: MembershipWarehouseGenerationPort,
  authority: { sourceKey: string; publicationKey: string; memberIds: readonly string[] },
  options: { signal: AbortSignal; clock?: () => number },
): Promise<{
  sourceCapture: MembershipGeneration;
  publication: MembershipGenerationPublication;
  warehouseSelection: unknown;
}> {
  assertMembershipHistoryKeys(authority.sourceKey, authority.publicationKey);
  const source = membershipGenerationSchema.parse(supplied),
    { signature, ...body } = source;
  if (
    authority.sourceKey === authority.publicationKey ||
    signature !== membershipHistoryDigest('generation', body, authority.sourceKey)
  )
    throw publicMembershipHistoryError();
  options.signal.throwIfAborted();
  const facts = await warehouse.read(source, options);
  options.signal.throwIfAborted();
  const selection = validateMembershipSelection(
      facts.selection,
      source.asOf,
      source.cutoff,
      authority.memberIds,
    ),
    selectionHash = membershipSelectionHash(selection),
    now = options.clock?.() ?? Date.now();
  if (
    facts.invalidRows !== '0' ||
    facts.duplicateIds !== '0' ||
    facts.latestTies !== (source.sourceOrderCount === '0' ? '0' : '1') ||
    facts.orderCount !== source.sourceOrderCount ||
    facts.selectedOrderCount !== source.sourceSelectedOrderCount ||
    facts.lineCount !== source.sourceLineCount ||
    selectionHash !== source.selectionHash ||
    now < source.capturedAt
  )
    throw publicMembershipHistoryError();
  const publicationBody = {
    contract: membershipGenerationPublicationContract,
    generationId: source.generationId,
    sourceCaptureHash: signature,
    warehouseOrderCount: facts.orderCount,
    warehouseSelectedOrderCount: facts.selectedOrderCount,
    warehouseLineCount: facts.lineCount,
    warehouseSelectionHash: selectionHash,
    publishedAt: now,
  };
  return {
    sourceCapture: source,
    warehouseSelection: selection,
    publication: membershipGenerationPublicationSchema.parse({
      ...publicationBody,
      signature: membershipHistoryDigest('publication', publicationBody, authority.publicationKey),
    }),
  };
}
