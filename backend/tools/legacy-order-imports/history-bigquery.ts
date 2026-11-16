/** Generated-literal-only SELECT qualification. No source rows, DDL or exports. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';
import {
  legacyOrderImportHistory,
  legacyOrderImportHistorySql,
  legacyOrderImportHistoryHashes,
} from '../../src/modules/legacy-order-imports/history.js';
import {
  historyNow,
  historyOptions,
  importHistoryFixture,
  importHistorySnapshot,
} from '../../tests/legacy-order-imports/history-fixtures.js';
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'",
  text = (value: string | null) => (value === null ? 'CAST(NULL AS STRING)' : quote(value)),
  stamp = (value: string) =>
    'TIMESTAMP ' + quote(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z'));
function select(fields: Record<string, string>) {
  return (
    'SELECT ' +
    Object.entries(fields)
      .map(([name, value]) => value + ' AS ' + name)
      .join(',') +
    ' FROM UNNEST([1]) AS fixture_singleton'
  );
}
const fixture = importHistoryFixture(),
  generation = '123e4567-e89b-42d3-a456-426614174100';
function sql(statement: string, mode: string) {
  const anchor = fixture.anchor,
    j = anchor.job,
    hashes = legacyOrderImportHistoryHashes(anchor, fixture.rows),
    pub = importHistorySnapshot(anchor, fixture.rows).publications[0]!;
  let publication =
    select({
      generation_id: quote(generation),
      contract_version: quote(historyOptions.ORDER_IMPORT_HISTORY_CONTRACT!),
      job_id: quote(j.id),
      actor_id: quote(j.actorId),
      request_hash: quote(j.requestHash),
      source_complete: mode === 'incomplete' ? 'FALSE' : 'TRUE',
      source_snapshot_id: quote(pub.sourceSnapshotId),
      source_snapshot_at: stamp(pub.sourceSnapshotAt),
      source_cdc_watermark: stamp(
        mode === 'old-checkpoint' ? '2026-11-01T10:03:00.000Z' : pub.sourceCdcWatermark,
      ),
      published_at: stamp(pub.publishedAt),
      source_rows: String(j.totalOrders),
      warehouse_rows: String(j.totalOrders),
      source_job_hash: quote(hashes.jobHash),
      warehouse_job_hash: quote(hashes.jobHash),
      source_result_hash: quote(hashes.resultHash),
      warehouse_result_hash: quote(hashes.resultHash),
    }) + (mode === 'missing-publication' ? ' WHERE FALSE' : '');
  if (mode === 'duplicate-publication') publication += ' UNION ALL ' + publication;
  const job = select({
    generation_id: quote(generation),
    job_id: quote(j.id),
    job_sequence: quote(j.sequence.toString()),
    actor_id: quote(j.actorId),
    request_hash: quote(j.requestHash),
    kind: quote(j.kind),
    state: quote(j.state),
    total_orders: String(j.totalOrders),
    imported_orders: String(j.importedOrders),
    failed_orders: String(j.failedOrders),
    cancelled_orders: String(j.cancelledOrders),
    error_code: text(j.errorCode),
    created_at: stamp(j.createdAt),
    updated_at: stamp(j.updatedAt),
    completed_at: stamp(j.completedAt!),
  });
  const rows = fixture.rows.map((row) => ({ ...row }));
  if (mode === 'changed-order') rows[0]!.orderId = '8';
  if (mode === 'hidden-foreign-scope') {
    rows[2]!.storeId = '20';
    rows[2]!.counterId = '21';
  }
  if (mode === 'duplicate-row') rows.push({ ...rows[1]! });
  if (mode === 'invalid-terminal-row') rows[1]!.orderId = '8';
  const result = rows
    .map(
      (row) =>
        select({
          generation_id: quote(generation),
          job_id: quote(j.id),
          actor_id: quote(j.actorId),
          request_hash: quote(j.requestHash),
          job_created_at: stamp(j.createdAt),
          job_updated_at: stamp(j.updatedAt),
          sequence: String(row.sequence),
          first_row: String(row.firstRow),
          operation_id: quote(row.operationId),
          store_id: quote(row.storeId),
          counter_id: quote(row.counterId),
          state: quote(row.state),
          order_id: text(row.orderId),
          receipt_id: text(row.receiptId),
          business_date: text(row.businessDate),
          error_code: text(row.errorCode),
          updated_at: stamp(row.updatedAt),
        }) + (mode === 'missing-results' ? ' WHERE FALSE' : ''),
    )
    .join(' UNION ALL ');
  return statement
    .replace(
      'WITH publications AS',
      `WITH fixture_publications AS(${publication}),fixture_jobs AS(${job}),fixture_results AS(${result}),publications AS`,
    )
    .replaceAll(
      '`' + historyOptions.BQ_ORDER_IMPORT_PUBLICATIONS_VIEW + '`',
      'fixture_publications',
    )
    .replaceAll('`' + historyOptions.BQ_ORDER_IMPORT_JOBS_VIEW + '`', 'fixture_jobs')
    .replaceAll('`' + historyOptions.BQ_ORDER_IMPORT_RESULTS_VIEW + '`', 'fixture_results');
}
let stage = 'setup';
try {
  const config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'history-literal-fixture-'.repeat(4),
      BIGQUERY_PROJECT_ID: 'tssgcp2025',
      BIGQUERY_LOCATION: 'asia-south1',
    }),
    client = new BigQuery({ projectId: 'tssgcp2025', location: 'asia-south1' }),
    results: { name: string; outcome: string }[] = [];
  for (const vector of [
    { name: 'complete-public-page', mode: 'valid', after: 0, limit: 2, valid: true },
    { name: 'empty-tail', mode: 'valid', after: 3, limit: 2, valid: true },
    { name: 'private-job-detail', mode: 'valid', after: 50000, limit: 1, valid: true },
    ...[
      'duplicate-publication',
      'missing-publication',
      'incomplete',
      'changed-order',
      'hidden-foreign-scope',
      'duplicate-row',
      'missing-results',
      'invalid-terminal-row',
      'old-checkpoint',
    ].map((mode) => ({ name: mode, mode, after: 0, limit: 1, valid: false })),
  ]) {
    stage = vector.name;
    const warehouse = {
      queryReport: async (
        statement: string,
        params: Record<string, unknown>,
        types: Record<string, string | string[]>,
      ) => {
        const query = sql(statement, vector.mode);
        assert(!query.includes('`tssgcp2025.'));
        let raw: unknown;
        try {
          [raw] = await client.query({
            query,
            params: normalizeWarehouseParameters(params, types),
            types,
            useLegacySql: false,
            maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
            jobTimeoutMs: 10000,
            labels: { application: 'pos-rewrite', resource: 'order-import-history-fixture' },
          });
        } catch (error) {
          const parsed = z
            .object({
              code: z.union([z.string(), z.number()]).optional(),
              errors: z
                .array(z.object({ reason: z.string().optional(), message: z.string().optional() }))
                .optional(),
            })
            .passthrough()
            .safeParse(error);
          const message = parsed.success ? parsed.data.errors?.[0]?.message : undefined;
          console.error(
            JSON.stringify({
              eventId: 'ORDER_IMPORT_HISTORY_QUERY_DIAGNOSTIC',
              stage,
              code: parsed.success ? parsed.data.code : undefined,
              reasons: parsed.success ? parsed.data.errors?.map((item) => item.reason) : undefined,
              terms: message
                ? [
                    'syntax',
                    'array',
                    'null',
                    'unrecognized',
                    'type',
                    'name',
                    'argument',
                    'query',
                    'parameter',
                    'aggregate',
                    'struct',
                    'duplicate',
                    'column',
                    'field',
                    'table',
                    'function',
                    'offset',
                    'limit',
                    'order',
                    'correlated',
                    'timestamp',
                    'regexp',
                    'permission',
                    'billing',
                  ].filter((term) => message.toLowerCase().includes(term))
                : undefined,
              position: message ? /\[(\d+):(\d+)\]/.exec(message)?.slice(1) : undefined,
            }),
          );
          throw error;
        }
        return z.array(z.record(z.string(), z.unknown())).parse(raw);
      },
    };
    const read = legacyOrderImportHistory(config, historyOptions, warehouse, () => historyNow),
      operation =
        vector.name === 'private-job-detail'
          ? read.detail(fixture.anchor)
          : read.results(fixture.anchor, vector.after, vector.limit);
    if (vector.valid) {
      const result = await operation;
      if (vector.name === 'private-job-detail')
        assert.deepEqual(result, {
          id: fixture.anchor.job.id,
          kind: 'offline',
          state: 'CANCELLED',
          totalOrders: 3,
          importedOrders: 1,
          failedOrders: 1,
          cancelledOrders: 1,
          errorCode: null,
          createdAt: fixture.anchor.job.createdAt,
          updatedAt: fixture.anchor.job.updatedAt,
          completedAt: fixture.anchor.job.completedAt,
        });
      else
        assert.deepEqual(
          result,
          fixture.rows.filter((row) => row.sequence > vector.after).slice(0, vector.limit),
        );
      results.push({ name: vector.name, outcome: 'verified' });
    } else {
      await assert.rejects(operation, { code: 'ORDER_IMPORT_HISTORY_INVALID' });
      results.push({ name: vector.name, outcome: 'rejected-incomplete-or-inconsistent' });
    }
  }
  const directory = 'parity/evidence/legacy-order-imports';
  await mkdir(directory, { recursive: true });
  await writeFile(
    directory + '/history-bigquery.json.tmp',
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope:
          'Generated-literal-only SELECTs, no source rows, DDL or exports; no deployed projection claim',
        contract: historyOptions.ORDER_IMPORT_HISTORY_CONTRACT,
        statementSha256: createHash('sha256')
          .update(legacyOrderImportHistorySql(historyOptions))
          .digest('hex'),
        byteCap: config.BIGQUERY_MAX_BYTES_BILLED,
        jobSequence: fixture.anchor.job.sequence.toString(),
        results,
      },
      null,
      2,
    ) + '\n',
  );
  await rename(directory + '/history-bigquery.json.tmp', directory + '/history-bigquery.json');
  console.log(JSON.stringify({ checks: results.length, sourceRowsRead: 0 }));
} catch (error) {
  const code = z.object({ code: z.string() }).passthrough().safeParse(error);
  console.error(
    JSON.stringify({
      eventId: 'ORDER_IMPORT_HISTORY_FIXTURE_FAILED',
      stage,
      code: code.success ? code.data.code : undefined,
    }),
  );
  process.exitCode = 1;
}
