import { Temporal } from '@js-temporal/polyfill';
import { couponHistoryScopeSchema, type CouponHistoryScope } from './history.js';
import {
  couponPublicationContract,
  couponPublicationError,
  type CouponSourceCapture,
} from './history-publication.js';
import {
  couponWarehouseCandidateContract,
  couponWarehouseProjectionContract,
  requireCouponWarehouseOptions,
  type CouponBigQueryOptions,
} from './history-warehouse-contracts.js';
const statements = new WeakSet<object>();
export interface CouponWarehouseStatement {
  readonly statement: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly types: Readonly<Record<string, string>>;
  readonly purpose: 'read' | 'candidate';
}
export function assertCouponWarehouseStatement(value: CouponWarehouseStatement) {
  if (!statements.has(value)) throw couponPublicationError('QUERY_DEFINITION', 503);
}
/** One immutable generation, one bounded JSON row. Business facts below are
 * aggregates of primitive order/log rows; no source count field is selected. */
export function couponWarehouseSql(
  supplied: CouponBigQueryOptions,
  scope: CouponHistoryScope,
  headHash: string,
  capture?: CouponSourceCapture,
): CouponWarehouseStatement {
  const mode = capture ? 'candidate' : 'read',
    options = requireCouponWarehouseOptions(supplied, mode),
    parsedScope = couponHistoryScopeSchema.safeParse(scope);
  if (!parsedScope.success) throw couponPublicationError('QUERY_SCOPE');
  const request = parsedScope.data;
  if (
    !/^[a-f0-9]{64}$/.test(headHash) ||
    request.sourceTimeZone !== options.CSV_COUPON_SOURCE_TIMEZONE
  )
    throw couponPublicationError('QUERY_SCOPE');
  if (
    capture &&
    (JSON.stringify(capture.scope) !== JSON.stringify(request) ||
      capture.controlHeadHash !== headHash)
  )
    throw couponPublicationError('QUERY_SCOPE');
  const point = Temporal.PlainDateTime.from(request.asOf.replace(' ', 'T')),
    dayStart = point.toPlainDate().toString() + ' 00:00:00',
    dayEnd = point.add({ days: 1 }).toPlainDate().toString() + ' 00:00:00',
    monthStart = point.with({ day: 1 }).toPlainDate().toString() + ' 00:00:00',
    monthEnd = point.with({ day: 1 }).add({ months: 1 }).toPlainDate().toString() + ' 00:00:00';
  const manifests = capture
    ? options.BQ_CSV_COUPON_CANDIDATES_VIEW!
    : options.BQ_CSV_COUPON_PUBLICATIONS_VIEW!;
  const scopeFilter = `scope_shard=@shard AND contract=@contract AND operation_id=@operation AND request_hash=@requestHash AND plan_hash=@planHash
AND customer_id=@customer AND coupon_id=@coupon AND configuration_hash=@configurationHash AND as_of=@asOf AND source_time_zone=@zone
AND control_head_hash=@headHash${capture ? ' AND generation_id=@generation AND snapshot_id=@snapshot AND source_capture_hash=@captureHash' : ''}`;
  const invalidId = (name: string, positive = false) =>
    positive
      ? `(${name} IS NULL OR SAFE_CAST(${name} AS INT64) IS NULL OR SAFE_CAST(${name} AS INT64)<=0 OR ${name}!=CAST(SAFE_CAST(${name} AS INT64) AS STRING))`
      : `(${name} IS NOT NULL AND (SAFE_CAST(${name} AS INT64) IS NULL OR ${name}!=CAST(SAFE_CAST(${name} AS INT64) AS STRING)))`;
  const wrongProjection = `projection_contract IS NULL OR projection_contract!=@projectionContract OR control_head_hash IS NULL OR control_head_hash!=@headHash OR snapshot_id IS NULL OR snapshot_id NOT IN(SELECT snapshot_id FROM manifests)`;
  const statement = `WITH manifests AS (
SELECT * FROM \`${manifests}\` WHERE ${scopeFilter} LIMIT 2
), source_orders AS (
SELECT * FROM \`${options.BQ_CSV_COUPON_ORDERS_VIEW}\` WHERE scope_shard=@shard AND generation_id IN(SELECT generation_id FROM manifests)
), source_logs AS (
SELECT * FROM \`${options.BQ_CSV_COUPON_LOGS_VIEW}\` WHERE scope_shard=@shard AND generation_id IN(SELECT generation_id FROM manifests)
), source_controls AS (
SELECT * FROM \`${options.BQ_CSV_COUPON_CONTROLS_VIEW}\` WHERE scope_shard=@shard AND generation_id IN(SELECT generation_id FROM manifests)
), order_multipliers AS (
SELECT user_id,coupon_used,COUNT(*) AS n FROM source_orders WHERE order_status NOT IN(0,17) GROUP BY user_id,coupon_used
), active_logs AS (
SELECT coupon_id,COUNT(*) AS n FROM source_logs WHERE user_id=@customer AND status=1 GROUP BY coupon_id
), month_logs AS (
SELECT coupon_id,COUNT(*) AS n FROM source_logs WHERE user_id=@customer AND coupon_id=@coupon AND status=1 AND created_at>=@monthStart AND created_at<@monthEnd GROUP BY coupon_id
), lot_usage AS (
SELECT c.coupon_id,c.same_code,c.no_times_allowed,c.unique_no_times_allowed,
SUM(CAST(l.n AS BIGNUMERIC)*CAST(o.n AS BIGNUMERIC)) AS n
FROM source_controls c JOIN active_logs l ON l.coupon_id=c.coupon_id
JOIN order_multipliers o ON o.user_id=@customer AND o.coupon_used=c.coupon_id
WHERE c.present=TRUE AND c.lot_matches=TRUE GROUP BY c.coupon_id,c.same_code,c.no_times_allowed,c.unique_no_times_allowed
)
SELECT TO_JSON_STRING(STRUCT(
ARRAY(SELECT AS STRUCT contract,generation_id AS generationId,snapshot_id AS snapshotId,source_capture_hash AS sourceCaptureHash,control_head_hash AS controlHeadHash,
UNIX_MILLIS(source_cdc_through) AS sourceCdcThrough,
CASE WHEN BYTE_LENGTH(source_capture_document)<=262144 THEN source_capture_document ELSE NULL END AS sourceCaptureDocument,
CASE WHEN BYTE_LENGTH(control_document)<=262144 THEN control_document ELSE NULL END AS controlDocument,
${capture ? 'candidate_complete AS candidateComplete' : 'CASE WHEN BYTE_LENGTH(publication_document)<=262144 THEN publication_document ELSE NULL END AS publicationDocument'}
FROM manifests) AS manifests,
STRUCT(
CAST((SELECT COUNT(*) FROM source_orders) AS STRING) AS orders,
CAST((SELECT COUNT(DISTINCT order_id) FROM source_orders) AS STRING) AS uniqueOrders,
CAST((SELECT COUNT(*) FROM source_logs) AS STRING) AS logs,
CAST((SELECT COUNT(DISTINCT log_id) FROM source_logs) AS STRING) AS uniqueLogs,
CAST((SELECT COUNT(*) FROM source_controls) AS STRING) AS controls,
CAST((SELECT COUNT(DISTINCT coupon_id) FROM source_controls) AS STRING) AS uniqueControls,
CAST((SELECT COUNT(*) FROM source_orders WHERE ${invalidId('order_id', true)} OR ${invalidId('user_id')} OR ${invalidId('coupon_used')} OR (${wrongProjection}) OR NOT(COALESCE(user_id=@customer,FALSE) OR COALESCE(coupon_used=@coupon,FALSE))) AS STRING) AS invalidOrders,
CAST((SELECT COUNT(*) FROM source_logs WHERE ${invalidId('log_id', true)} OR ${invalidId('user_id')} OR ${invalidId('coupon_id')} OR user_id IS NULL OR user_id!=@customer OR (${wrongProjection})) AS STRING) AS invalidLogs,
CAST((SELECT COUNT(*) FROM source_controls WHERE ${invalidId('coupon_id')} OR coupon_id IS NULL OR (${wrongProjection})) AS STRING) AS invalidControls,
CAST((SELECT COUNT(*) FROM source_logs l WHERE l.coupon_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_controls c WHERE c.coupon_id=l.coupon_id)) AS STRING) AS uncoveredLogs,
CAST((SELECT COUNT(*) FROM source_orders o WHERE o.user_id=@customer AND o.coupon_used IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_controls c WHERE c.coupon_id=o.coupon_used)) AS STRING) AS uncoveredOrders,
CAST((SELECT COUNT(*) FROM lot_usage) AS STRING) AS lots
) AS actual,
ARRAY(SELECT AS STRUCT coupon_id AS couponId,present,lot_matches AS lotMatches,same_code AS sameCode,no_times_allowed AS noTimesAllowed,unique_no_times_allowed AS uniqueNoTimesAllowed FROM source_controls ORDER BY SAFE_CAST(coupon_id AS INT64) LIMIT @controlTake) AS controls,
STRUCT(
CAST((SELECT COUNT(1) FROM source_orders WHERE order_status NOT IN(0,4,7,15,17,22,31,33) AND coupon_used=@coupon) AS STRING) AS globalUsage,
CAST((SELECT COUNT(order_id) FROM source_orders WHERE created_at>=@dayStart AND created_at<@dayEnd AND order_status NOT IN(0,17) AND user_id=@customer AND coupon_used=@coupon) AS STRING) AS birthdayTodayUsage,
CAST((SELECT COUNT(order_id) FROM source_orders WHERE user_id=@customer AND order_status NOT IN(0,17)) AS STRING) AS customerOrderCount,
CAST(COALESCE((SELECT SUM(CAST(l.n AS BIGNUMERIC)*CAST(o.n AS BIGNUMERIC)) FROM month_logs l JOIN order_multipliers o ON o.user_id=@customer AND o.coupon_used=l.coupon_id),CAST(0 AS BIGNUMERIC)) AS STRING) AS monthlyJoinedUsage,
ARRAY(SELECT AS STRUCT coupon_id AS couponId,same_code AS sameCode,no_times_allowed AS noTimesAllowed,unique_no_times_allowed AS uniqueNoTimesAllowed,CAST(n AS STRING) AS usedCount FROM lot_usage ORDER BY SAFE_CAST(coupon_id AS INT64) LIMIT @lotTake) AS lotCounts
) AS facts
)) AS document`;
  const params: Record<string, unknown> = {
    shard: Number(BigInt(request.customerId) % 1024n),
    contract: capture ? couponWarehouseCandidateContract : couponPublicationContract,
    operation: request.operationId,
    requestHash: request.requestHash,
    planHash: request.planHash,
    customer: request.customerId,
    coupon: request.couponId,
    configurationHash: request.configurationHash,
    asOf: request.asOf,
    zone: request.sourceTimeZone,
    headHash,
    projectionContract: couponWarehouseProjectionContract,
    dayStart,
    dayEnd,
    monthStart,
    monthEnd,
    controlTake: options.CSV_COUPON_MAX_CONTROLS + 1,
    lotTake: options.CSV_COUPON_MAX_LOTS + 1,
  };
  const types: Record<string, string> = Object.fromEntries(
    Object.keys(params).map((name) => [
      name,
      ['shard', 'controlTake', 'lotTake'].includes(name)
        ? 'INT64'
        : ['asOf', 'dayStart', 'dayEnd', 'monthStart', 'monthEnd'].includes(name)
          ? 'DATETIME'
          : 'STRING',
    ]),
  );
  if (capture) {
    Object.assign(params, {
      generation: capture.generationId,
      snapshot: capture.snapshotId,
      captureHash: capture.signature,
    });
    Object.assign(types, { generation: 'STRING', snapshot: 'STRING', captureHash: 'STRING' });
  }
  const value = Object.freeze({
    statement,
    params: Object.freeze(params),
    types: Object.freeze(types),
    purpose: mode,
  });
  statements.add(value);
  return value;
}
