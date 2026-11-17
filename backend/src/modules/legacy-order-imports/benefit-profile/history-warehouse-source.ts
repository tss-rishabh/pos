import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { couponControlHashSql } from './native.js';
import { benefitHash } from './contracts.js';
import {
  assertCouponHistoryWriterDefinitions,
  couponHistoryWriterDefinitions,
} from './history-writers.js';
import {
  couponHeadSchema,
  verifyCouponSourceCapture,
  couponPublicationError,
  type CouponSourceCapture,
} from './history-publication.js';
import {
  couponComparisonSchema,
  couponComparisonFingerprint,
  couponWarehouseControlRowSchema,
  couponWarehouseMaximumControls,
  sealCouponWarehouseControls,
  type CouponComparison,
} from './history-warehouse-contracts.js';

/** Qualification/publisher-only read port. It is never a CsvCouponHistoryPort
 * or an application fallback. It captures comparison flags/configuration, not
 * the five usage counts that the warehouse must independently recompute. */
export function couponWarehouseSourceControls(
  db: Pick<Databases, 'get'>,
  authority: { sourceKey: string; comparisonFingerprint: string },
  options: { clock?: () => number; maxControls?: number } = {},
) {
  const clock = options.clock ?? Date.now,
    maxControls = options.maxControls ?? couponWarehouseMaximumControls;
  if (
    !/^[!-~]{32,4096}$/.test(authority.sourceKey) ||
    !benefitHash.safeParse(authority.comparisonFingerprint).success ||
    !Number.isSafeInteger(maxControls) ||
    maxControls < 1 ||
    maxControls > couponWarehouseMaximumControls
  )
    throw couponPublicationError('CONFIGURATION', 503);
  return {
    async capture(supplied: CouponSourceCapture) {
      const capture = verifyCouponSourceCapture(supplied, authority.sourceKey, clock());
      try {
        return await db.get('primary').transaction(
          async (tx) => {
            const [identityRaw] = await tx.execute(
                sql`SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema`,
              ),
              identity = z
                .array(z.object({ serverUuid: z.uuid(), sourceSchema: z.string() }))
                .length(1)
                .parse(identityRaw)[0]!;
            if (
              identity.serverUuid !== capture.serverUuid ||
              identity.sourceSchema !== capture.sourceSchema
            )
              throw couponPublicationError('CONTROLS_SOURCE_CHANGED');
            const [headRaw] =
                await tx.execute(sql`SELECT kind,scope_id AS scopeId,CAST(revision AS CHAR) AS revision FROM pos_rewrite_coupon_history_heads
WHERE (kind='controls' AND scope_id='0') OR (kind='coupon' AND scope_id=${capture.scope.couponId}) OR (kind='customer' AND scope_id=${capture.scope.customerId}) ORDER BY kind,scope_id LIMIT 4`),
              heads = z.array(couponHeadSchema).length(3).parse(headRaw);
            if (JSON.stringify(heads) !== JSON.stringify(capture.heads))
              throw couponPublicationError('CONTROLS_SOURCE_CHANGED');
            const [targetRaw] = await tx.execute(
                sql`SELECT ${sql.raw(couponControlHashSql)} AS inputHash FROM coupons WHERE id=${capture.scope.couponId} LIMIT 2`,
              ),
              target = z
                .array(z.object({ inputHash: benefitHash }))
                .length(1)
                .parse(targetRaw)[0]!;
            if (target.inputHash !== capture.couponInputHash)
              throw couponPublicationError('CONTROLS_SOURCE_CHANGED');
            const [columnsRaw] =
                await tx.execute(sql`SELECT c.COLUMN_NAME AS \`column\`,c.DATA_TYPE AS dataType,c.CHARACTER_SET_NAME AS characterSet,c.COLLATION_NAME AS collation,k.PAD_ATTRIBUTE AS padAttribute
FROM information_schema.COLUMNS c JOIN information_schema.COLLATIONS k ON k.COLLATION_NAME=c.COLLATION_NAME
WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME='coupons' AND c.COLUMN_NAME IN('coupon_lot_no','voucher_code') ORDER BY c.COLUMN_NAME LIMIT 3`),
              columns = z.array(z.record(z.string(), z.unknown())).length(2).parse(columnsRaw);
            const comparison: CouponComparison = couponComparisonSchema.parse({
              contract: 'pos-native-coupon-comparisons-v1',
              lot: columns.find((row) => row.column === 'coupon_lot_no'),
              code: columns.find((row) => row.column === 'voucher_code'),
              lotComparison: 'native-column-equality-and-nonempty',
              codeComparison: 'python-decoded-exact-utf8',
            });
            if (couponComparisonFingerprint(comparison) !== authority.comparisonFingerprint)
              throw couponPublicationError('COMPARISON_UNQUALIFIED', 503);
            const [raw] =
              await tx.execute(sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(r.coupon_id AS CHAR) AS couponId,
CAST((c.id IS NOT NULL) AS CHAR) AS present,
CAST(CASE WHEN c.id IS NOT NULL AND target.coupon_lot_no IS NOT NULL AND target.coupon_lot_no<>'' AND c.coupon_lot_no=target.coupon_lot_no THEN 1 ELSE 0 END AS CHAR) AS lotMatches,
CAST(CASE WHEN c.id IS NOT NULL THEN (BINARY CONVERT(c.voucher_code USING utf8mb4)=BINARY CONVERT(target.voucher_code USING utf8mb4)) ELSE 0 END AS CHAR) AS sameCode,
CAST(c.no_times_allowed AS CHAR) AS noTimesAllowed,CAST(c.unique_no_times_allowed AS CHAR) AS uniqueNoTimesAllowed
FROM (SELECT coupon_used AS coupon_id FROM orders WHERE user_id=${capture.scope.customerId}
UNION SELECT coupon_id FROM order_coupon_log WHERE user_id=${capture.scope.customerId}
UNION SELECT CAST(${capture.scope.couponId} AS SIGNED)) r
LEFT JOIN coupons c ON c.id=r.coupon_id JOIN coupons target ON target.id=${capture.scope.couponId}
WHERE r.coupon_id IS NOT NULL ORDER BY r.coupon_id LIMIT ${maxControls + 1}`);
            if (!Array.isArray(raw) || raw.length > maxControls)
              throw couponPublicationError('CONTROLS_TOO_LARGE');
            const bits = z
              .object({
                couponId: z.string(),
                present: z.enum(['0', '1']),
                lotMatches: z.enum(['0', '1']),
                sameCode: z.enum(['0', '1']),
                noTimesAllowed: z.string().nullable(),
                uniqueNoTimesAllowed: z.string().nullable(),
              })
              .strict();
            const rows = z
              .array(bits)
              .max(maxControls)
              .parse(raw)
              .map((row) =>
                couponWarehouseControlRowSchema.parse({
                  ...row,
                  present: row.present === '1',
                  lotMatches: row.lotMatches === '1',
                  sameCode: row.sameCode === '1',
                }),
              );
            // The exact native equality/PAD SPACE semantics are resolved here; no raw
            // voucher/lot string crosses this source boundary or enters BQ parameters.
            const names = sql.join(
              couponHistoryWriterDefinitions.map((row) => sql`${row.name}`),
              sql`,`,
            );
            const [definitions] =
              await tx.execute(sql`SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS \`table\`,EVENT_MANIPULATION AS \`event\`,ACTION_TIMING AS \`timing\`,ACTION_STATEMENT AS \`statement\`
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_SCHEMA=DATABASE() AND TRIGGER_NAME IN(${names}) LIMIT 11`);
            if (assertCouponHistoryWriterDefinitions(definitions) !== capture.writersDefinitionHash)
              throw couponPublicationError('WRITERS_UNQUALIFIED', 503);
            verifyCouponSourceCapture(capture, authority.sourceKey, clock());
            return {
              manifest: sealCouponWarehouseControls(
                capture,
                comparison,
                rows,
                authority.sourceKey,
                clock(),
              ),
              rows,
            };
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
        throw couponPublicationError('CONTROLS_SOURCE_UNAVAILABLE', 503);
      }
    },
  };
}
