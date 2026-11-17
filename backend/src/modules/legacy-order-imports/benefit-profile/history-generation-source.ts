import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import {
  generationOriginContract,
  generationOriginIdentitySchema,
  type GenerationSourceOrigin,
} from './history-generation-origin.js';
import { benefitCount, benefitHash, benefitSourceCommit } from './contracts.js';
import { couponControlHashSql } from './native.js';
import { couponSourceQueryContract, couponPublicationFactsSchema } from './history-publication.js';
import { couponHistoryWitnessSchema } from './bridge.js';
import { assertCouponHistoryWriterMetadata } from './history-writers.js';
import {
  readNativeHeadMetadata,
  type NativeHeadMetadataOptions,
} from '../../screening-origins/native-head-metadata.js';
import {
  couponComparisonSchema,
  couponComparisonFingerprint,
  couponWarehouseControlRowSchema,
  type CouponWarehouseControlRow,
} from './history-warehouse-contracts.js';
import {
  verifyGenerationControl,
  type GenerationControlDescriptor,
} from './history-generation-control.js';
import {
  generationAccumulator,
  generationRowSchema,
  type GenerationRow,
} from './history-generation-projections.js';
import {
  generationSourceContract,
  generationScopeSchema,
  generationHeadHash,
  generationControlsHash,
  signGenerationCapture,
  verifyGenerationCapture,
  generationError,
  type GenerationCapture,
  type GenerationScope,
} from './history-generation-contracts.js';
type Transaction = Parameters<Parameters<ReturnType<Databases['get']>['transaction']>[0]>[0];
export interface GenerationSourceSnapshot {
  capture: GenerationCapture;
  controls: CouponWarehouseControlRow[];
  logs: GenerationRow[];
}
export interface GenerationSourcePort {
  capture(
    scope: GenerationScope,
    control: GenerationControlDescriptor,
    signal?: AbortSignal,
  ): Promise<GenerationSourceSnapshot>;
}
async function oneCount(tx: Transaction, query: SQL) {
  const [rows] = await tx.execute(query);
  return z
    .array(z.object({ value: benefitCount }).strict())
    .length(1)
    .parse(rows)[0]!.value;
}
/** Background/explicit publisher ONLY. No runtime factory imports this module. */
export function couponGenerationSource(
  origin: GenerationSourceOrigin,
  authority: { sourceKey: string; comparisonFingerprint: string; sourceTimeZone: string },
  options: {
    headMetadata?: NativeHeadMetadataOptions;
    clock?: () => number;
    maxRows?: number;
    maxLogs?: number;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): GenerationSourcePort {
  if (
    origin.contract !== generationOriginContract ||
    !generationOriginIdentitySchema.safeParse(origin.expected).success ||
    typeof origin.database !== 'function'
  )
    throw generationError('ORIGIN_REQUIRED', 503);
  const clock = options.clock ?? Date.now,
    maxRows = options.maxRows ?? 100000,
    maxLogs = options.maxLogs ?? 10000,
    maxBytes = options.maxBytes ?? 8000000,
    timeout = options.timeoutMs ?? 30000;
  if (
    !/^[!-~]{32,4096}$/.test(authority.sourceKey) ||
    !benefitHash.safeParse(authority.comparisonFingerprint).success ||
    ![maxRows, maxLogs, maxBytes, timeout].every(Number.isSafeInteger) ||
    maxRows < 1 ||
    maxRows > 1000000 ||
    maxLogs < 1 ||
    maxLogs > 50000 ||
    maxBytes < 1 ||
    maxBytes > 8000000 ||
    timeout < 1 ||
    timeout > 40000
  )
    throw generationError('CONFIGURATION', 503);
  return {
    async capture(input, controlInput, signal) {
      if (!options.headMetadata) throw generationError('CONFIGURATION', 503);
      const scope = generationScopeSchema.parse(input),
        control = verifyGenerationControl(controlInput, authority.sourceKey, clock());
      const descriptor = control.data;
      if (
        descriptor.couponId !== scope.couponId ||
        descriptor.configurationHash !== scope.configurationHash ||
        descriptor.sourceTimeZone !== scope.sourceTimeZone ||
        descriptor.sourceDay !== scope.sourceDay
      )
        throw generationError('CONTROL_REQUIRED', 503);
      if (
        scope.sourceTimeZone !== authority.sourceTimeZone ||
        Temporal.Instant.fromEpochMilliseconds(clock())
          .toZonedDateTimeISO(scope.sourceTimeZone)
          .toPlainDate()
          .toString() !== scope.sourceDay
      )
        throw generationError('SOURCE_DAY');
      const point = Temporal.PlainDate.from(scope.sourceDay),
        today = scope.sourceDay,
        tomorrow = point.add({ days: 1 }).toString(),
        monthStart = point.with({ day: 1 }).toString(),
        monthEnd = point.with({ day: 1 }).add({ months: 1 }).toString();
      const started = performance.now();
      const budget = () => {
        signal?.throwIfAborted();
        if (performance.now() - started > timeout) throw generationError('SOURCE_BUDGET', 503);
      };
      budget();
      try {
        return await origin.database().transaction(
          async (tx) => {
            const capturedAt = clock(),
              sourceAsOf = Temporal.Instant.fromEpochMilliseconds(capturedAt)
                .toZonedDateTimeISO(scope.sourceTimeZone)
                .toPlainDateTime()
                .toString({ smallestUnit: 'second' })
                .replace('T', ' ');
            const [meta] = await tx.execute(
                sql`SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema`,
              ),
              identity = z
                .array(
                  z.object({
                    serverUuid: z.uuid(),
                    sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
                  }),
                )
                .length(1)
                .parse(meta)[0]!;
            if (
              identity.serverUuid !== origin.expected.serverUuid ||
              identity.sourceSchema !== origin.expected.sourceSchema
            )
              throw generationError('ORIGIN_CHANGED', 503);
            const [couponRows] = await tx.execute(
                sql`SELECT ${sql.raw(couponControlHashSql)} AS inputHash FROM coupons WHERE id=${scope.couponId} LIMIT 2`,
              ),
              coupon = z
                .array(z.object({ inputHash: benefitHash }))
                .length(1)
                .parse(couponRows)[0]!;
            const [rawHeads] = await tx.execute(
              sql`SELECT kind,scope_id AS scopeId,CAST(revision AS CHAR) AS revision FROM pos_rewrite_coupon_history_heads WHERE (kind='controls' AND scope_id='0') OR (kind='coupon' AND scope_id=${scope.couponId}) OR (kind='customer' AND scope_id=${scope.customerId}) ORDER BY kind,scope_id LIMIT 4`,
            );
            for (const table of ['orders', 'order_coupon_log', 'coupons', 'users'])
              await tx.execute(sql.raw('SELECT id FROM ' + table + ' LIMIT 0'));
            const headMetadata = await readNativeHeadMetadata(tx, options.headMetadata!);
            const writersDefinitionHash = assertCouponHistoryWriterMetadata(
                headMetadata.couponTriggers,
              ),
              witness = couponHistoryWitnessSchema.parse({
                writersContract: 'pos-csv-coupon-history-all-writers-v1',
                writersDefinitionHash,
                ...identity,
                heads: rawHeads,
              });
            if (
              descriptor.serverUuid !== identity.serverUuid ||
              descriptor.sourceSchema !== identity.sourceSchema ||
              descriptor.couponInputHash !== coupon.inputHash ||
              JSON.stringify(descriptor.heads) !== JSON.stringify(witness.heads.slice(0, 2))
            )
              throw generationError('CONTROL_CHANGED', 503);
            budget();
            const boundedCount = (query: SQL) => {
              budget();
              return oneCount(tx, query);
            };
            const globalUsage = await boundedCount(
                sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(COUNT(1) AS CHAR) AS value
            FROM orders o WHERE o.order_status NOT IN (0,4,7,15,17,22,31,33) AND o.coupon_used=${scope.couponId}`,
              ),
              birthdayTodayUsage = await boundedCount(
                sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(COUNT(id) AS CHAR) AS value
            FROM orders WHERE created_at>=${today} AND created_at<${tomorrow}
            AND order_status NOT IN (0,17) AND user_id=${sql`CAST(${scope.customerId} AS SIGNED)`} AND coupon_used=${scope.couponId}`,
              ),
              customerOrderCount = await boundedCount(
                sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(COUNT(id) AS CHAR) AS value
            FROM orders WHERE user_id=${sql`CAST(${scope.customerId} AS SIGNED)`} AND order_status NOT IN (0,17)`,
              ),
              monthlyJoinedUsage = await boundedCount(
                sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(COUNT(ocl.id) AS CHAR) AS value
            FROM order_coupon_log ocl JOIN orders o ON ocl.user_id=o.user_id AND ocl.coupon_id=o.coupon_used
            AND o.order_status NOT IN (0,17) WHERE ocl.created_at>=${monthStart} AND ocl.created_at<${monthEnd}
            AND ocl.user_id=${sql`CAST(${scope.customerId} AS SIGNED)`} AND ocl.coupon_id=${scope.couponId} AND ocl.status=1`,
              );
            // Match native lot collation in SQL, but source's Python voucher-code
            // equality is exact bytes. No coupon code/lot value leaves the source.
            const [lots] =
              await tx.execute(sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(c.id AS CHAR) AS couponId,
            CAST(c.no_times_allowed AS CHAR) AS noTimesAllowed,
            CAST(c.unique_no_times_allowed AS CHAR) AS uniqueNoTimesAllowed,
            (BINARY CONVERT(c.voucher_code USING utf8mb4)=BINARY CONVERT(target.voucher_code USING utf8mb4)) AS sameCode,
            CAST(COUNT(cl.coupon_id) AS CHAR) AS usedCount
            FROM order_coupon_log cl JOIN coupons c ON c.id=cl.coupon_id
            JOIN orders o ON cl.user_id=o.user_id AND cl.coupon_id=o.coupon_used AND o.order_status NOT IN (0,17)
            JOIN coupons target ON target.id=${scope.couponId}
            WHERE target.coupon_lot_no IS NOT NULL AND target.coupon_lot_no<>''
            AND c.coupon_lot_no=target.coupon_lot_no AND cl.user_id=${sql`CAST(${scope.customerId} AS SIGNED)`} AND cl.status=1
            GROUP BY c.id,c.no_times_allowed,c.unique_no_times_allowed,c.voucher_code,target.voucher_code
            ORDER BY c.id LIMIT 1001`);
            if (!Array.isArray(lots) || lots.length > 1000)
              throw generationError('SOURCE_TOO_LARGE');
            const rawLots = z
                .array(
                  z
                    .object({
                      couponId: z.string(),
                      noTimesAllowed: z.string(),
                      uniqueNoTimesAllowed: z.string(),
                      sameCode: z.union([z.literal(0), z.literal(1)]),
                      usedCount: z.string(),
                    })
                    .strict(),
                )
                .max(1000)
                .parse(lots),
              facts = couponPublicationFactsSchema.parse({
                globalUsage,
                birthdayTodayUsage,
                customerOrderCount,
                monthlyJoinedUsage,
                lotCounts: rawLots.map((row) => ({ ...row, sameCode: row.sameCode === 1 })),
              });

            budget();
            const [columns] = await tx.execute(
              sql`SELECT c.COLUMN_NAME AS \`column\`,c.DATA_TYPE AS dataType,c.CHARACTER_SET_NAME AS characterSet,c.COLLATION_NAME AS collation,k.PAD_ATTRIBUTE AS padAttribute FROM information_schema.COLUMNS c JOIN information_schema.COLLATIONS k ON k.COLLATION_NAME=c.COLLATION_NAME WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME='coupons' AND c.COLUMN_NAME IN('coupon_lot_no','voucher_code') ORDER BY c.COLUMN_NAME LIMIT 3`,
            );
            const metadata = z.array(z.record(z.string(), z.unknown())).length(2).parse(columns),
              comparison = couponComparisonSchema.parse({
                contract: 'pos-native-coupon-comparisons-v1',
                lot: metadata.find((v) => v.column === 'coupon_lot_no'),
                code: metadata.find((v) => v.column === 'voucher_code'),
                lotComparison: 'native-column-equality-and-nonempty',
                codeComparison: 'python-decoded-exact-utf8',
              });
            if (couponComparisonFingerprint(comparison) !== authority.comparisonFingerprint)
              throw generationError('COMPARISON');
            const [rawControls] = await tx.execute(
              sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(r.coupon_id AS CHAR) AS couponId,CAST((c.id IS NOT NULL) AS CHAR) AS present,CAST(CASE WHEN c.id IS NOT NULL AND target.coupon_lot_no IS NOT NULL AND target.coupon_lot_no<>'' AND c.coupon_lot_no=target.coupon_lot_no THEN 1 ELSE 0 END AS CHAR) AS lotMatches,CAST(CASE WHEN c.id IS NOT NULL THEN (BINARY CONVERT(c.voucher_code USING utf8mb4)=BINARY CONVERT(target.voucher_code USING utf8mb4)) ELSE 0 END AS CHAR) AS sameCode,CAST(c.no_times_allowed AS CHAR) AS noTimesAllowed,CAST(c.unique_no_times_allowed AS CHAR) AS uniqueNoTimesAllowed FROM (SELECT coupon_used AS coupon_id FROM orders WHERE user_id=${sql`CAST(${scope.customerId} AS SIGNED)`} UNION SELECT coupon_id FROM order_coupon_log WHERE user_id=${sql`CAST(${scope.customerId} AS SIGNED)`} UNION SELECT CAST(${scope.couponId} AS SIGNED)) r LEFT JOIN coupons c ON c.id=r.coupon_id JOIN coupons target ON target.id=${scope.couponId} WHERE r.coupon_id IS NOT NULL ORDER BY r.coupon_id LIMIT 10001`,
            );
            const controls = z
              .array(
                z
                  .object({
                    couponId: z.string(),
                    present: z.enum(['0', '1']),
                    lotMatches: z.enum(['0', '1']),
                    sameCode: z.enum(['0', '1']),
                    noTimesAllowed: z.string().nullable(),
                    uniqueNoTimesAllowed: z.string().nullable(),
                  })
                  .strict(),
              )
              .max(10000)
              .parse(rawControls)
              .map((v) =>
                couponWarehouseControlRowSchema.parse({
                  ...v,
                  present: v.present === '1',
                  lotMatches: v.lotMatches === '1',
                  sameCode: v.sameCode === '1',
                }),
              );
            async function project(kind: 'order' | 'log') {
              const accumulator = generationAccumulator(kind),
                logs: GenerationRow[] = [];
              let after: string | null = null,
                count = 0,
                bytes = 0;
              while (true) {
                budget();
                const [raw]: readonly [unknown, unknown] =
                  kind === 'order'
                    ? await tx.execute(
                        sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(id AS CHAR) AS id,CAST(user_id AS CHAR) AS userId,CAST(coupon_used AS CHAR) AS couponId,CAST(order_status AS CHAR) AS status,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS createdAt FROM orders WHERE (user_id=${sql`CAST(${scope.customerId} AS SIGNED)`} OR coupon_used=${scope.couponId}) ${after === null ? sql`` : sql`AND id>CAST(${after} AS SIGNED)`} ORDER BY id LIMIT 1000`,
                      )
                    : await tx.execute(
                        sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(id AS CHAR) AS id,CAST(user_id AS CHAR) AS userId,CAST(coupon_id AS CHAR) AS couponId,CAST(status AS CHAR) AS status,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS createdAt FROM order_coupon_log WHERE user_id=${sql`CAST(${scope.customerId} AS SIGNED)`} ${after === null ? sql`` : sql`AND id>CAST(${after} AS SIGNED)`} ORDER BY id LIMIT 1000`,
                      );
                const rows: GenerationRow[] = z
                  .array(
                    z
                      .object({
                        id: z.string(),
                        userId: z.string().nullable(),
                        couponId: z.string().nullable(),
                        status: z
                          .string()
                          .regex(/^-?[0-9]{1,9}$/)
                          .nullable(),
                        createdAt: z.string().nullable(),
                      })
                      .strict(),
                  )
                  .max(1000)
                  .parse(raw)
                  .map((v) =>
                    generationRowSchema.parse({
                      ...v,
                      status: v.status === null ? null : Number(v.status),
                    }),
                  );
                for (const row of rows) {
                  count++;
                  if (count > (kind === 'order' ? maxRows : maxLogs))
                    throw generationError('SOURCE_ROWS');
                  accumulator.add(row);
                  after = row.id;
                  if (kind === 'log') {
                    bytes += Buffer.byteLength(JSON.stringify(row));
                    if (bytes > maxBytes) throw generationError('SOURCE_BYTES');
                    logs.push(row);
                  }
                }
                if (rows.length < 1000) break;
              }
              return { summary: accumulator.finish(), logs };
            }
            const orders = await project('order'),
              logs = await project('log');
            budget();
            const generationId = createHash('sha256').update(randomUUID()).digest('hex'),
              snapshotId = randomUUID(),
              finishedAt = clock();
            const body: Omit<GenerationCapture, 'signature'> = {
              contract: generationSourceContract,
              sourceCommit: benefitSourceCommit,
              queryContract: couponSourceQueryContract,
              scope,
              control,
              sourceAsOf,
              generationId,
              snapshotId,
              ...witness,
              headHash: generationHeadHash(scope, witness, authority.sourceKey),
              capturedAt,
              finishedAt,
              couponInputHash: coupon.inputHash,
              comparison,
              comparisonFingerprint: authority.comparisonFingerprint,
              controlsCount: String(controls.length),
              controlsHash: generationControlsHash(
                scope,
                generationId,
                snapshotId,
                controls,
                authority.sourceKey,
              ),
              projections: { orders: orders.summary, logs: logs.summary },
              facts,
            };
            const capture = verifyGenerationCapture(
              signGenerationCapture(body, authority.sourceKey),
              authority.sourceKey,
              clock(),
            );
            return { capture, controls, logs: logs.logs };
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          error.code.startsWith('ORDER_IMPORT_COUPON_PUBLICATION_')
        )
          throw error;
        throw generationError('SOURCE_UNAVAILABLE', 503);
      }
    },
  };
}
