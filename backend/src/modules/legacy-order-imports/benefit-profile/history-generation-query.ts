import { Temporal } from '@js-temporal/polyfill';
import {
  generationScopeSchema,
  generationCandidateContract,
  generationPublicationContract,
  generationProjectionContract,
  generationError,
  type GenerationScope,
  type GenerationCapture,
} from './history-generation-contracts.js';
import { requireGenerationOptions, type GenerationOptions } from './history-generation-options.js';
import { generationHashCtes } from './history-generation-projections.js';
const statements = new WeakSet<object>();
export interface GenerationStatement {
  readonly statement: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly types: Readonly<Record<string, string>>;
  readonly purpose: 'read' | 'candidate';
}
export function assertGenerationStatement(v: GenerationStatement) {
  if (!statements.has(v)) throw generationError('QUERY_DEFINITION', 503);
}
export function generationSql(
  supplied: GenerationOptions,
  scope: GenerationScope,
  headHash: string,
  capture?: GenerationCapture,
  selectedMode?: 'read' | 'candidate',
): GenerationStatement {
  const mode = selectedMode ?? (capture ? 'candidate' : 'read'),
    options = requireGenerationOptions(supplied, mode),
    request = generationScopeSchema.parse(scope);
  if (
    !/^[a-f0-9]{64}$/.test(headHash) ||
    request.sourceTimeZone !== options.sourceTimeZone ||
    (capture &&
      (JSON.stringify(capture.scope) !== JSON.stringify(request) || capture.headHash !== headHash))
  )
    throw generationError('QUERY_SCOPE');
  const point = Temporal.PlainDate.from(request.sourceDay),
    dayStart = request.sourceDay + ' 00:00:00',
    dayEnd = point.add({ days: 1 }).toString() + ' 00:00:00',
    monthStart = point.with({ day: 1 }).toString() + ' 00:00:00',
    monthEnd = point.with({ day: 1 }).add({ months: 1 }).toString() + ' 00:00:00';
  const manifests = mode === 'candidate' ? options.candidates! : options.publications!;
  const scopeFilter =
    'scope_shard=@shard AND contract=@contract AND customer_id=@customer AND coupon_id=@coupon AND configuration_hash=@configurationHash AND source_day=@sourceDay AND source_time_zone=@zone AND head_hash=@headHash' +
    (capture
      ? ' AND generation_id=@generation AND snapshot_id=@snapshot AND capture_hash=@captureHash'
      : '');
  const prefix = capture
    ? 'WITH manifests AS (SELECT * FROM `' + manifests + '` WHERE ' + scopeFilter + ' LIMIT 2)'
    : 'WITH matches AS (SELECT * FROM `' +
      manifests +
      '` WHERE ' +
      scopeFilter +
      '), selected AS (SELECT generation_id FROM matches ORDER BY published_at DESC,generation_id DESC LIMIT 1), manifests AS (SELECT * FROM matches WHERE generation_id IN(SELECT generation_id FROM selected) LIMIT 2)';
  const invalidId = (name: string, positive = false) =>
    positive
      ? `(${name} IS NULL OR SAFE_CAST(${name} AS INT64) IS NULL OR SAFE_CAST(${name} AS INT64)<=0 OR ${name}!=CAST(SAFE_CAST(${name} AS INT64) AS STRING))`
      : `(${name} IS NOT NULL AND (SAFE_CAST(${name} AS INT64) IS NULL OR ${name}!=CAST(SAFE_CAST(${name} AS INT64) AS STRING)))`;
  const wrongProjection =
    'projection_contract IS NULL OR projection_contract!=@projectionContract OR head_hash IS NULL OR head_hash!=@headHash OR snapshot_id IS NULL OR snapshot_id NOT IN(SELECT snapshot_id FROM manifests)';
  const statement = `${prefix}, source_orders AS (
SELECT * FROM \`${options.orders}\` WHERE source_day=@sourceDay AND scope_shard=@shard AND generation_id IN(SELECT generation_id FROM manifests)
), source_logs AS (
SELECT * FROM \`${options.logs}\` WHERE source_day=@sourceDay AND scope_shard=@shard AND generation_id IN(SELECT generation_id FROM manifests)
), source_controls AS (
SELECT * FROM \`${options.controls}\` WHERE source_day=@sourceDay AND scope_shard=@shard AND generation_id IN(SELECT generation_id FROM manifests)
), ${generationHashCtes('order', 'source_orders')},
${generationHashCtes('log', 'source_logs')},
order_multipliers AS (
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
ARRAY(SELECT AS STRUCT contract,generation_id AS generationId,snapshot_id AS snapshotId,capture_hash AS captureHash,head_hash AS headHash,
UNIX_MILLIS(materialized_at) AS materializedAt,
CASE WHEN BYTE_LENGTH(capture_document)<=262144 THEN capture_document ELSE NULL END AS captureDocument,
${mode === 'candidate' ? 'candidate_complete AS candidateComplete' : 'CASE WHEN BYTE_LENGTH(publication_document)<=262144 THEN publication_document ELSE NULL END AS publicationDocument'}
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
STRUCT((SELECT AS STRUCT * FROM order_projection) AS orders,(SELECT AS STRUCT * FROM log_projection) AS logs) AS projections,
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
    contract: mode === 'candidate' ? generationCandidateContract : generationPublicationContract,
    customer: request.customerId,
    coupon: request.couponId,
    configurationHash: request.configurationHash,
    sourceDay: request.sourceDay,
    zone: request.sourceTimeZone,
    headHash,
    projectionContract: generationProjectionContract,
    dayStart,
    dayEnd,
    monthStart,
    monthEnd,
    controlTake: options.maxControls + 1,
    lotTake: options.maxLots + 1,
  };
  const types: Record<string, string> = Object.fromEntries(
    Object.keys(params).map((name) => [
      name,
      ['shard', 'controlTake', 'lotTake'].includes(name)
        ? 'INT64'
        : name === 'sourceDay'
          ? 'DATE'
          : ['dayStart', 'dayEnd', 'monthStart', 'monthEnd'].includes(name)
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
