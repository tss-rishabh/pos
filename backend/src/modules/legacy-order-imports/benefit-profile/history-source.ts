import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { benefitCount, benefitHash, benefitSourceCommit } from './contracts.js';
import { couponHistoryScopeSchema, type CouponHistoryScope } from './history.js';
import { couponControlHashSql } from './native.js';
import {
  couponSourceCaptureContract,
  couponSourceQueryContract,
  couponHistoryWritersContract,
  couponControlHeadHash,
  couponSourceCaptureHash,
  couponFactsHash,
  couponPublicationFactsSchema,
  couponHeadSchema,
  couponPublicationError,
  verifyCouponSourceCapture,
  type CouponSourceCapture,
} from './history-publication.js';
import { assertCouponHistoryWriterMetadata } from './history-writers.js';
import {
  readNativeHeadMetadata,
  type NativeHeadMetadataOptions,
} from '../../screening-origins/native-head-metadata.js';

export interface CouponSourceCapturePort {
  capture(scope: CouponHistoryScope): Promise<CouponSourceCapture>;
}
type Transaction = Parameters<Parameters<ReturnType<Databases['get']>['transaction']>[0]>[0];
async function oneCount(tx: Transaction, statement: SQL) {
  const [rows] = await tx.execute(statement);
  const parsed = z
    .array(z.object({ value: benefitCount }).strict())
    .length(1)
    .safeParse(rows);
  if (!parsed.success) throw couponPublicationError('SOURCE_INVALID');
  return parsed.data[0]!.value;
}

/** This is the independent publisher's source attestation, not an application
 * historical reader/fallback. Only bounded aggregate results leave its native
 * read-only snapshot; normal historical eligibility consumes the BQ publication.
 * No source/coupon/order/head table is mutated by this port. */
export function couponHistorySourceCapture(
  db: Pick<Databases, 'get'>,
  options: {
    headMetadata?: NativeHeadMetadataOptions;
    contract: typeof couponSourceCaptureContract;
    sourceKey: string;
    sourceTimeZone: string;
  },
  dependencies: { clock?: () => number } = {},
): CouponSourceCapturePort {
  if (
    options.contract !== couponSourceCaptureContract ||
    !/^[!-~]{32,4096}$/.test(options.sourceKey)
  )
    throw couponPublicationError('CONFIGURATION', 503);
  const key = options.sourceKey,
    clock = dependencies.clock ?? Date.now;
  return {
    async capture(supplied) {
      if (!options.headMetadata) throw couponPublicationError('CONFIGURATION', 503);
      const parsed = couponHistoryScopeSchema.safeParse(supplied);
      if (!parsed.success || parsed.data.sourceTimeZone !== options.sourceTimeZone)
        throw couponPublicationError('SOURCE_CLOCK');
      const scope = parsed.data,
        point = Temporal.PlainDateTime.from(scope.asOf.replace(' ', 'T')),
        today = point.toPlainDate().toString(),
        tomorrow = point.add({ days: 1 }).toPlainDate().toString(),
        monthStart = point.with({ day: 1 }).toPlainDate().toString(),
        monthEnd = point.with({ day: 1 }).add({ months: 1 }).toPlainDate().toString();
      try {
        return await db.get('primary').transaction(
          async (tx) => {
            const capturedAt = clock();
            const [metadata] = await tx.execute(
                sql`SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema`,
              ),
              identity = z
                .array(
                  z
                    .object({
                      serverUuid: z.uuid(),
                      sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
                    })
                    .strict(),
                )
                .length(1)
                .parse(metadata)[0]!;
            const [couponRows] =
                await tx.execute(sql`SELECT ${sql.raw(couponControlHashSql)} AS inputHash
            FROM coupons WHERE id=${scope.couponId} LIMIT 2`),
              coupon = z
                .array(z.object({ inputHash: benefitHash }).strict())
                .length(1)
                .parse(couponRows)[0]!;
            const [heads] =
                await tx.execute(sql`SELECT kind,scope_id AS scopeId,CAST(revision AS CHAR) AS revision
            FROM pos_rewrite_coupon_history_heads WHERE (kind='controls' AND scope_id='0')
            OR (kind='coupon' AND scope_id=${scope.couponId}) OR (kind='customer' AND scope_id=${scope.customerId})
            ORDER BY kind,scope_id LIMIT 4`),
              headRows = z.array(couponHeadSchema).length(3).parse(heads);
            if (headRows[0]?.kind !== 'controls' || BigInt(headRows[0].revision) < 1n)
              throw couponPublicationError('WRITERS_UNQUALIFIED', 503);
            const globalUsage = await oneCount(
                tx,
                sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(COUNT(1) AS CHAR) AS value
            FROM orders o WHERE o.order_status NOT IN (0,4,7,15,17,22,31,33) AND o.coupon_used=${scope.couponId}`,
              ),
              birthdayTodayUsage = await oneCount(
                tx,
                sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(COUNT(id) AS CHAR) AS value
            FROM orders WHERE created_at>=${today} AND created_at<${tomorrow}
            AND order_status NOT IN (0,17) AND user_id=${scope.customerId} AND coupon_used=${scope.couponId}`,
              ),
              customerOrderCount = await oneCount(
                tx,
                sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(COUNT(id) AS CHAR) AS value
            FROM orders WHERE user_id=${scope.customerId} AND order_status NOT IN (0,17)`,
              ),
              monthlyJoinedUsage = await oneCount(
                tx,
                sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(COUNT(ocl.id) AS CHAR) AS value
            FROM order_coupon_log ocl JOIN orders o ON ocl.user_id=o.user_id AND ocl.coupon_id=o.coupon_used
            AND o.order_status NOT IN (0,17) WHERE ocl.created_at>=${monthStart} AND ocl.created_at<${monthEnd}
            AND ocl.user_id=${scope.customerId} AND ocl.coupon_id=${scope.couponId} AND ocl.status=1`,
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
            AND c.coupon_lot_no=target.coupon_lot_no AND cl.user_id=${scope.customerId} AND cl.status=1
            GROUP BY c.id,c.no_times_allowed,c.unique_no_times_allowed,c.voucher_code,target.voucher_code
            ORDER BY c.id LIMIT 1001`);
            if (!Array.isArray(lots) || lots.length > 1000)
              throw couponPublicationError('SOURCE_TOO_LARGE');
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
            // All source tables have now been read under the snapshot, holding
            // their metadata locks. Verify the installed mutation coverage too.
            const headMetadata = await readNativeHeadMetadata(tx, options.headMetadata!);
            const writersDefinitionHash = assertCouponHistoryWriterMetadata(
                headMetadata.couponTriggers,
              ),
              finishedAt = clock();
            const body: Omit<CouponSourceCapture, 'signature'> = {
              contract: couponSourceCaptureContract,
              sourceCommit: benefitSourceCommit,
              queryContract: couponSourceQueryContract,
              writersContract: couponHistoryWritersContract,
              writersDefinitionHash,
              scope,
              generationId: createHash('sha256').update(randomUUID()).digest('hex'),
              snapshotId: randomUUID(),
              ...identity,
              capturedAt,
              finishedAt,
              heads: headRows,
              couponInputHash: coupon.inputHash,
              facts,
              factsHash: couponFactsHash(scope, facts, key),
              controlHeadHash: couponControlHeadHash(
                { scope, ...identity, writersDefinitionHash, heads: headRows },
                key,
              ),
            };
            return verifyCouponSourceCapture(
              { ...body, signature: couponSourceCaptureHash(body, key) },
              key,
              clock(),
            );
          },
          {
            // The first InnoDB read fixes the REPEATABLE READ snapshot.
            // This pinned driver joins START TRANSACTION options without a
            // comma, so combining READ ONLY with WITH CONSISTENT SNAPSHOT
            // emits invalid SQL; neither snapshot consistency nor read-only
            // access requires that combination here.
            isolationLevel: 'repeatable read',
            accessMode: 'read only',
          },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          error.code.startsWith('ORDER_IMPORT_COUPON_PUBLICATION_')
        )
          throw error;
        throw couponPublicationError('SOURCE_UNAVAILABLE', 503);
      }
    },
  };
}
