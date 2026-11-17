import type { GenerationStatement } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-query.js';
import { generationProjectionContract } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-contracts.js';
import type { generationFixture } from '../../tests/legacy-import-coupon-history/generation-fixtures.js';
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
      ? 'SELECT * FROM UNNEST([' +
        rows.map((row) => 'STRUCT(' + projection(row) + ')').join(',') +
        '])'
      : 'SELECT ' + projection({}) + ' FROM UNNEST([0]) WHERE FALSE') +
    ')'
  );
}
/** Substitute ONLY synthetic literal CTEs for every qualified view reference.
 * No raw application table, CREATE, DML, export or destination is left. */
export function generationFixtureSql(
  input: GenerationStatement,
  f: ReturnType<typeof generationFixture>,
  mutate?: (rows: {
    orders: Record<string, Cell>[];
    logs: Record<string, Cell>[];
    controls: Record<string, Cell>[];
    manifests: Record<string, Cell>[];
  }) => void,
) {
  const common = {
    scope_shard: Number(BigInt(f.scope.customerId) % 1024n),
    source_day: f.scope.sourceDay,
    projection_contract: generationProjectionContract,
    generation_id: f.capture.generationId,
    snapshot_id: f.capture.snapshotId,
    head_hash: f.capture.headHash,
  };
  const rows = {
    orders: f.orderRows.map((row) => ({
      ...common,
      order_id: row.id,
      user_id: row.userId,
      coupon_used: row.couponId,
      order_status: row.status,
      created_at: row.createdAt,
    })),
    logs: f.logRows.map((row) => ({
      ...common,
      log_id: row.id,
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
            ? 'pos-csv-coupon-generation-candidate-v1'
            : f.publication.contract,
        customer_id: f.scope.customerId,
        coupon_id: f.scope.couponId,
        configuration_hash: f.scope.configurationHash,
        source_day: f.scope.sourceDay,
        source_time_zone: f.scope.sourceTimeZone,
        generation_id: f.capture.generationId,
        snapshot_id: f.capture.snapshotId,
        capture_hash: f.capture.signature,
        head_hash: f.capture.headHash,
        materialized_at: new Date(f.facts.materializedAt).toISOString(),
        capture_document: JSON.stringify(f.capture),
        publication_document: JSON.stringify(f.publication),
        published_at: new Date(f.publication.publishedAt).toISOString(),
        candidate_complete: true,
      },
    ],
  };
  mutate?.(rows);
  const fields = {
    scope_shard: 'INT64',
    source_day: 'DATE',
    projection_contract: 'STRING',
    generation_id: 'STRING',
    snapshot_id: 'STRING',
    head_hash: 'STRING',
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
        customer_id: 'STRING',
        coupon_id: 'STRING',
        configuration_hash: 'STRING',
        source_day: 'DATE',
        source_time_zone: 'STRING',
        generation_id: 'STRING',
        snapshot_id: 'STRING',
        capture_hash: 'STRING',
        head_hash: 'STRING',
        materialized_at: 'TIMESTAMP',
        capture_document: 'STRING',
        publication_document: 'STRING',
        published_at: 'TIMESTAMP',
        candidate_complete: 'BOOL',
      },
      rows.manifests,
    ),
  ];
  let statement = input.statement;
  const tick = String.fromCharCode(96);
  for (const [view, replacement] of [
    [f.options.orders, 'fixture_orders'],
    [f.options.logs, 'fixture_logs'],
    [f.options.controls, 'fixture_controls'],
    [f.options.publications, 'fixture_manifests'],
    [f.options.candidates, 'fixture_manifests'],
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
