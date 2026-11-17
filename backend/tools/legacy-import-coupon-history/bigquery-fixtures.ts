import type { CouponWarehouseStatement } from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-query.js';
import { couponWarehouseProjectionContract } from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-contracts.js';
import type { warehouseFixture } from '../../tests/legacy-import-coupon-history/warehouse-fixtures.js';
type Cell = string | boolean | number | null;
function cte(
  name: string,
  fields: Readonly<Record<string, string>>,
  rows: ReadonlyArray<Record<string, Cell>>,
) {
  const quoted = (value: string) => "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const projection = (row: Record<string, Cell>) =>
    Object.entries(fields)
      .map(([key, type]) => {
        const cell = row[key] ?? null,
          literal =
            cell === null
              ? 'NULL'
              : typeof cell === 'string'
                ? quoted(cell)
                : typeof cell === 'boolean'
                  ? cell
                    ? 'TRUE'
                    : 'FALSE'
                  : String(cell);
        return 'CAST(' + literal + ' AS ' + type + ') AS ' + key;
      })
      .join(',');
  return (
    name +
    ' AS (' +
    (rows.length
      ? rows.map((row) => 'SELECT ' + projection(row)).join(' UNION ALL ')
      : 'SELECT ' + projection({}) + ' FROM UNNEST([0]) WHERE FALSE') +
    ')'
  );
}
/** Substitute ONLY synthetic literal CTEs for every qualified view reference.
 * No raw application table, CREATE, DML, export or destination is left. */
export function couponFixtureSql(
  input: CouponWarehouseStatement,
  f: ReturnType<typeof warehouseFixture>,
  mutate?: (rows: {
    orders: Record<string, Cell>[];
    logs: Record<string, Cell>[];
    controls: Record<string, Cell>[];
    manifests: Record<string, Cell>[];
  }) => void,
) {
  const common = {
    scope_shard: Number(BigInt(f.scope.customerId) % 1024n),
    projection_contract: couponWarehouseProjectionContract,
    generation_id: f.capture.generationId,
    snapshot_id: f.capture.snapshotId,
    control_head_hash: f.capture.controlHeadHash,
  };
  const rows = {
    orders: f.orders.map((row) => ({
      ...common,
      order_id: row.orderId,
      user_id: row.userId,
      coupon_used: row.couponId,
      order_status: row.status,
      created_at: row.createdAt,
    })),
    logs: f.logs.map((row) => ({
      ...common,
      log_id: row.logId,
      user_id: row.userId,
      coupon_id: row.couponId,
      status: row.status,
      created_at: row.createdAt,
    })),
    controls: f.controls.map((row) => ({
      ...common,
      coupon_id: row.couponId,
      present: row.present,
      lot_matches: row.lotMatches,
      same_code: row.sameCode,
      no_times_allowed: row.noTimesAllowed,
      unique_no_times_allowed: row.uniqueNoTimesAllowed,
    })),
    manifests: [
      {
        scope_shard: common.scope_shard,
        contract:
          input.purpose === 'candidate'
            ? 'pos-csv-coupon-warehouse-candidate-v1'
            : f.publication.contract,
        operation_id: f.scope.operationId,
        request_hash: f.scope.requestHash,
        plan_hash: f.scope.planHash,
        customer_id: f.scope.customerId,
        coupon_id: f.scope.couponId,
        configuration_hash: f.scope.configurationHash,
        as_of: f.scope.asOf,
        source_time_zone: f.scope.sourceTimeZone,
        generation_id: f.capture.generationId,
        snapshot_id: f.capture.snapshotId,
        source_capture_hash: f.capture.signature,
        control_head_hash: f.capture.controlHeadHash,
        source_cdc_through: new Date(f.now).toISOString(),
        source_capture_document: JSON.stringify(f.capture),
        control_document: JSON.stringify(f.controlManifest),
        publication_document: JSON.stringify(f.publication),
        candidate_complete: true,
      },
    ],
  };
  mutate?.(rows);
  const fields = {
    scope_shard: 'INT64',
    projection_contract: 'STRING',
    generation_id: 'STRING',
    snapshot_id: 'STRING',
    control_head_hash: 'STRING',
  };
  const definitions = [
    cte(
      'fixture_orders',
      {
        ...fields,
        order_id: 'STRING',
        user_id: 'STRING',
        coupon_used: 'STRING',
        order_status: 'INT64',
        created_at: 'DATETIME',
      },
      rows.orders,
    ),
    cte(
      'fixture_logs',
      {
        ...fields,
        log_id: 'STRING',
        user_id: 'STRING',
        coupon_id: 'STRING',
        status: 'INT64',
        created_at: 'DATETIME',
      },
      rows.logs,
    ),
    cte(
      'fixture_controls',
      {
        ...fields,
        coupon_id: 'STRING',
        present: 'BOOL',
        lot_matches: 'BOOL',
        same_code: 'BOOL',
        no_times_allowed: 'STRING',
        unique_no_times_allowed: 'STRING',
      },
      rows.controls,
    ),
    cte(
      'fixture_manifests',
      {
        scope_shard: 'INT64',
        contract: 'STRING',
        operation_id: 'STRING',
        request_hash: 'STRING',
        plan_hash: 'STRING',
        customer_id: 'STRING',
        coupon_id: 'STRING',
        configuration_hash: 'STRING',
        as_of: 'DATETIME',
        source_time_zone: 'STRING',
        generation_id: 'STRING',
        snapshot_id: 'STRING',
        source_capture_hash: 'STRING',
        control_head_hash: 'STRING',
        source_cdc_through: 'TIMESTAMP',
        source_capture_document: 'STRING',
        control_document: 'STRING',
        publication_document: 'STRING',
        candidate_complete: 'BOOL',
      },
      rows.manifests,
    ),
  ];
  let statement = input.statement;
  const tick = String.fromCharCode(96);
  for (const [view, replacement] of [
    [f.options.BQ_CSV_COUPON_ORDERS_VIEW, 'fixture_orders'],
    [f.options.BQ_CSV_COUPON_LOGS_VIEW, 'fixture_logs'],
    [f.options.BQ_CSV_COUPON_CONTROLS_VIEW, 'fixture_controls'],
    [f.options.BQ_CSV_COUPON_PUBLICATIONS_VIEW, 'fixture_manifests'],
    [f.options.BQ_CSV_COUPON_CANDIDATES_VIEW, 'fixture_manifests'],
  ] as const)
    statement = statement.replaceAll(tick + view + tick, replacement);
  if (
    !/^WITH /.test(statement) ||
    statement.includes(tick + 'tssgcp2025.') ||
    /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|MERGE|EXPORT|CALL)\b/i.test(statement)
  )
    throw Error('COUPON_SYNTHETIC_QUERY_ONLY');
  return statement.replace(/^WITH /, 'WITH ' + definitions.join(',\n') + ',\n');
}
