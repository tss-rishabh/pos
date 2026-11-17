import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { bigint, datetime, int, mysqlTable, tinyint } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { AppError } from '../../../domain/errors.js';
import { csvMembershipHistoryRequestSchema, type CsvMembershipHistoryRequest } from './history.js';
import { csvMembershipSelectionHash, csvMembershipSourceInstant } from './bigquery.js';
import {
  csvMembershipSourceCaptureContract,
  csvMembershipSourceCaptureHash,
  csvMembershipSourceCommit,
  membershipPublicationError,
  validateCsvMembershipSourceSelection,
  verifyCsvMembershipSourceCapture,
  type CsvMembershipSourceCapture,
  type CsvMembershipSourceCapturePort,
} from './publication.js';
import { readMembershipSourceSnapshot } from './publication-transaction.js';
import { requestForCsvMembershipDispatch } from './bridge.js';

/** Narrow verified physical projections. The source HP exclusive flag is not
 * present in the generated Django mapping; this is never a schema migration. */
const headers = mysqlTable('orders', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  customerId: bigint('user_id', { mode: 'bigint' }).notNull(),
  paymentMethod: int('payment_method').notNull(),
  status: int('order_status').notNull(),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
});
const lines = mysqlTable('has_products', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  orderId: bigint('order_id', { mode: 'bigint' }).notNull(),
  productId: bigint('prod_id', { mode: 'bigint' }).notNull(),
  exclusive: tinyint('is_exclusive_order').notNull(),
});
export const csvMembershipNativeSnapshotContract = 'pos-csv-membership-native-snapshot-v1';
const optionsSchema = z.object({
  contract: z.literal(csvMembershipNativeSnapshotContract).optional(),
  sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  sourceServerUuid: z.uuid(),
  sourceTimeZone: z.string().min(1).max(128),
  timeoutMs: z.number().int().min(100).max(10000).default(8000),
  maxOrders: z.number().int().min(1).max(5000).default(1000),
  maxLines: z.number().int().min(1).max(10000).default(10000),
});
export type CsvMembershipNativeSnapshotOptions = z.input<typeof optionsSchema>;
function records<T>(value: unknown, schema: z.ZodType<T>) {
  const parsed = z.tuple([z.array(schema).max(100), z.unknown()]).safeParse(value);
  if (!parsed.success) throw membershipPublicationError('SOURCE_IDENTITY_REQUIRED', 503);
  return parsed.data[0];
}
/** Control-plane source authenticity capture, not an application historical
 * fallback. A separate verified source-writer identity is mandatory. This opens
 * its own READ ONLY consistent snapshot before financial dispatch; it accepts
 * no caller's writer transaction and makes no HTTP/BQ calls inside it. */
export function csvMembershipNativeSnapshot(
  db: Databases,
  suppliedOptions: CsvMembershipNativeSnapshotOptions,
  authority: { sourceKey: string; memberProductIds: readonly string[] },
  dependencies: { clock?: () => number } = {},
): CsvMembershipSourceCapturePort & {
  captureForDispatch(
    scope: Pick<
      CsvMembershipHistoryRequest,
      'operationId' | 'requestHash' | 'planHash' | 'customerId'
    >,
    generationId: string,
  ): Promise<CsvMembershipSourceCapture>;
} {
  const parsedOptions = optionsSchema.safeParse(suppliedOptions);
  if (!parsedOptions.success || !/^[!-~]{32,4096}$/.test(authority.sourceKey))
    throw membershipPublicationError('CONFIGURATION', 503);
  const options = parsedOptions.data,
    key = authority.sourceKey,
    members = [...authority.memberProductIds],
    clock = dependencies.clock ?? Date.now;
  if (
    !members.length ||
    members.length > 100 ||
    new Set(members).size !== members.length ||
    members.some((id) => !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)
  )
    throw membershipPublicationError('CONFIGURATION', 503);
  const capture = async (
    input: CsvMembershipHistoryRequest,
    generationId: string,
    deriveClock = false,
  ): Promise<CsvMembershipSourceCapture> => {
    if (options.contract !== csvMembershipNativeSnapshotContract)
      throw membershipPublicationError('SOURCE_REQUIRED', 503);
    let scope: CsvMembershipHistoryRequest;
    try {
      scope = csvMembershipHistoryRequestSchema.parse(input);
    } catch {
      throw membershipPublicationError('SOURCE_INVALID');
    }
    if (
      !/^[a-f0-9]{64}$/.test(generationId) ||
      !/^[1-9]\d{0,18}$/.test(scope.customerId) ||
      BigInt(scope.customerId) > 9223372036854775807n
    )
      throw membershipPublicationError('SOURCE_INVALID');
    const requestedAt = clock(),
      sourceAt = csvMembershipSourceInstant(scope.asOf, options.sourceTimeZone),
      start = performance.now();
    if (
      !Number.isSafeInteger(requestedAt) ||
      requestedAt < sourceAt ||
      requestedAt - sourceAt >= 60000
    )
      throw membershipPublicationError('SOURCE_STALE');
    let expired = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    function hint() {
      const remaining = Math.floor(options.timeoutMs - (performance.now() - start));
      if (expired || remaining < 1) throw membershipPublicationError('SOURCE_UNAVAILABLE', 503);
      return sql.raw('/*+ MAX_EXECUTION_TIME(' + remaining + ') */');
    }
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        abort.abort();
        reject(membershipPublicationError('SOURCE_UNAVAILABLE', 503));
      }, options.timeoutMs);
    });
    const work = (async () =>
      readMembershipSourceSnapshot(
        db.get('writer').$client,
        async (tx) => {
          hint();
          const capturedAt = clock(),
            executionScope = requestForCsvMembershipDispatch(scope, {
              sourceTimeZone: options.sourceTimeZone,
              clock: () => capturedAt,
            });
          if (!deriveClock && JSON.stringify(scope) !== JSON.stringify(executionScope))
            throw membershipPublicationError('SOURCE_CLOCK_CHANGED');
          scope = executionScope;
          const [identity] = records(
            await tx.execute(
              sql`SELECT DATABASE() AS schemaName,@@GLOBAL.server_uuid AS serverUuid,@@GLOBAL.read_only AS reader,@@GLOBAL.super_read_only AS superReader`,
            ),
            z
              .object({
                schemaName: z.literal(options.sourceSchema),
                serverUuid: z.literal(options.sourceServerUuid),
                reader: z.union([z.literal(0), z.literal('0')]),
                superReader: z.union([z.literal(0), z.literal('0')]),
              })
              .strict(),
          );
          if (!identity) throw membershipPublicationError('SOURCE_IDENTITY_REQUIRED', 503);
          const tables = records(
            await tx.execute(
              sql`SELECT TABLE_NAME AS name,TABLE_TYPE AS kind,ENGINE AS engine FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('orders','has_products')`,
            ),
            z
              .object({
                name: z.enum(['orders', 'has_products']),
                kind: z.literal('BASE TABLE'),
                engine: z.literal('InnoDB'),
              })
              .strict(),
          );
          if (tables.length !== 2 || new Set(tables.map((row) => row.name)).size !== 2)
            throw membershipPublicationError('SOURCE_IDENTITY_REQUIRED', 503);
          const where = and(
            eq(headers.customerId, BigInt(scope.customerId)),
            eq(headers.status, 3),
          );
          const [aggregate] = await tx
            .select({
              total: sql<string>`${hint()} CAST(COUNT(*) AS CHAR)`,
              invalid: sql<string>`CAST(COUNT(CASE WHEN ${headers.id}<=0 OR ${headers.createdAt} IS NULL OR YEAR(${headers.createdAt})=0 OR MICROSECOND(${headers.createdAt})<>0 OR ${headers.paymentMethod}<0 OR ${headers.paymentMethod}>32767 THEN 1 END) AS CHAR)`,
              maximum: sql<string | null>`MAX(${headers.createdAt})`,
            })
            .from(headers)
            .where(where);
          if (!aggregate || !/^\d+$/.test(aggregate.total) || aggregate.invalid !== '0')
            throw membershipPublicationError('SOURCE_INVALID');
          const fields = {
            id: sql<string>`${hint()} CAST(${headers.id} AS CHAR)`,
            paymentMethod: headers.paymentMethod,
            createdAt: headers.createdAt,
          };
          const latest = await tx
            .select(fields)
            .from(headers)
            .where(where)
            .orderBy(desc(headers.createdAt))
            .limit(1);
          if (aggregate.maximum !== null) {
            const [ties] = await tx
              .select({ count: sql<string>`${hint()} CAST(COUNT(*) AS CHAR)` })
              .from(headers)
              .where(and(where, eq(headers.createdAt, aggregate.maximum)));
            if (ties?.count !== '1') throw membershipPublicationError('SOURCE_AMBIGUOUS');
          }
          const recent = await tx
            .select({ ...fields, id: sql<string>`${hint()} CAST(${headers.id} AS CHAR)` })
            .from(headers)
            .where(and(where, gt(headers.createdAt, scope.cutoff)))
            .orderBy(desc(headers.createdAt))
            .limit(options.maxOrders + 1);
          if (recent.length > options.maxOrders)
            throw membershipPublicationError('SOURCE_TOO_LARGE');
          const selected = [
            ...new Map([...latest, ...recent].map((row) => [row.id, row])).values(),
          ];
          if (selected.length > options.maxOrders)
            throw membershipPublicationError('SOURCE_TOO_LARGE');
          const hp = selected.length
            ? await tx
                .select({
                  lineId: sql<string>`${hint()} CAST(${lines.id} AS CHAR)`,
                  orderId: sql<string>`CAST(${lines.orderId} AS CHAR)`,
                  productId: sql<string>`CAST(${lines.productId} AS CHAR)`,
                  isExclusiveOrder: lines.exclusive,
                })
                .from(lines)
                .where(
                  inArray(
                    lines.orderId,
                    selected.map((row) => BigInt(row.id)),
                  ),
                )
                .orderBy(asc(lines.orderId), asc(lines.id))
                .limit(options.maxLines + 1)
            : [];
          if (hp.length > options.maxLines) throw membershipPublicationError('SOURCE_TOO_LARGE');
          const rowLines = new Map<string, typeof hp>();
          for (const row of hp) {
            const entries = rowLines.get(row.orderId) ?? [];
            entries.push(row);
            rowLines.set(row.orderId, entries);
          }
          const assemble = (row: (typeof selected)[number]) => ({
            ...row,
            lines: (rowLines.get(row.id) ?? []).map(({ orderId: _order, ...line }) => line),
          });
          const raw = {
            lastDeliveredOrder: latest[0] ? assemble(latest[0]) : null,
            recentDeliveredOrders: recent.map(assemble),
          };
          const selection = validateCsvMembershipSourceSelection(raw, scope, members);
          const finishedAt = clock();
          const body: Omit<CsvMembershipSourceCapture, 'signature'> = {
            contract: csvMembershipSourceCaptureContract,
            sourceCommit: csvMembershipSourceCommit,
            scope,
            generationId,
            sourceSnapshotId: randomUUID(),
            sourceTimeZone: options.sourceTimeZone,
            sourceSchema: identity.schemaName,
            sourceServerUuid: identity.serverUuid,
            capturedAt,
            finishedAt,
            orderCount: aggregate.total,
            selectedOrderCount: String(selected.length),
            lineCount: String(hp.length),
            historyHash: csvMembershipSelectionHash(scope, selection),
            selection,
          };
          hint();
          const capture: CsvMembershipSourceCapture = {
            ...body,
            signature: csvMembershipSourceCaptureHash(body, key),
          };
          return verifyCsvMembershipSourceCapture(capture, key, members, finishedAt);
        },
        { signal: abort.signal },
      ))();
    try {
      return await Promise.race([work, deadline]);
    } catch (error) {
      if (error instanceof AppError && error.code.startsWith('ORDER_IMPORT_MEMBERSHIP_'))
        throw error;
      throw membershipPublicationError('SOURCE_UNAVAILABLE', 503);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    capture: (scope, generationId) => capture(scope, generationId),
    captureForDispatch: (scope, generationId) =>
      capture(
        requestForCsvMembershipDispatch(scope, { sourceTimeZone: options.sourceTimeZone, clock }),
        generationId,
        true,
      ),
  };
}
