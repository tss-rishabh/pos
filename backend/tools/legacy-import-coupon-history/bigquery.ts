/** Explicit read-only synthetic SELECT validation. Never reads a source row or
 * writes a warehouse object. Diagnostics intentionally exclude SDK error text. */
import { BigQuery, type Job } from '@google-cloud/bigquery';
import { z } from 'zod';
import { couponFixtureSql } from './bigquery-fixtures.js';
import { warehouseFixture } from '../../tests/legacy-import-coupon-history/warehouse-fixtures.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';
import { couponBigQueryHistory } from '../../src/modules/legacy-order-imports/benefit-profile/history-bigquery.js';
import {
  couponWarehouseCapture,
  sealCouponWarehousePublication,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-publication.js';
import {
  couponWarehouseSql,
  type CouponWarehouseStatement,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-warehouse-query.js';
let stage = 'configuration';
async function main() {
  if (!process.argv.includes('--synthetic') || !process.env.BQ_COUPON_HISTORY_VALIDATION_KEY_FILE)
    throw Error('EXPLICIT_SYNTHETIC_VALIDATION_REQUIRED');
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.BQ_COUPON_HISTORY_VALIDATION_KEY_FILE;
  const client = new BigQuery({
    projectId: 'tssgcp2025',
    location: 'asia-south1',
    autoRetry: false,
    maxRetries: 0,
  });
  client.timeout = 10000;
  let passed = 0,
    maxBytes = 0n;
  for (const mode of ['candidate', 'read'] as const)
    for (const scenario of [
      'literal',
      'zero',
      'duplicate',
      'mixed',
      'missing',
      'overflow',
      'orphan-control',
      'incomplete',
    ] as const) {
      const f = warehouseFixture(scenario === 'zero');
      let estimated = false,
        executed = false;
      function statement(input: CouponWarehouseStatement) {
        return couponFixtureSql(input, f, (rows) => {
          if (scenario === 'duplicate') rows.orders.push({ ...rows.orders[0]! });
          if (scenario === 'mixed') rows.logs[0]!.control_head_hash = '0'.repeat(64);
          if (scenario === 'missing') rows.manifests = [];
          if (scenario === 'overflow') rows.controls[1]!.no_times_allowed = '10000000000000000000';
          if (scenario === 'orphan-control')
            rows.controls = rows.controls.filter((row) => row.coupon_id !== '999');
          if (scenario === 'incomplete') rows.manifests[0]!.candidate_complete = false;
        });
      }
      async function job(input: CouponWarehouseStatement, dryRun: boolean): Promise<Job> {
        stage = 'synthetic-' + mode + '-' + scenario + (dryRun ? '-estimate' : '-select');
        let native: Job | undefined,
          late = false,
          timer: ReturnType<typeof setTimeout> | undefined;
        const work = client
          .createQueryJob({
            query: statement(input),
            params: normalizeWarehouseParameters(input.params, input.types),
            types: input.types,
            dryRun,
            useLegacySql: false,
            useQueryCache: false,
            location: 'asia-south1',
            maximumBytesBilled: '1000000',
            jobTimeoutMs: 10000,
            labels: { application: 'pos-rewrite', resource: 'synthetic-csv-coupon' },
          })
          .then(([value]) => {
            native = value;
            if (late) void value.cancel().catch(() => undefined);
            return value;
          });
        try {
          return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                late = true;
                if (native) void native.cancel().catch(() => undefined);
                reject(Error('SYNTHETIC_DEADLINE'));
              }, 15000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      const query = {
        estimate: async (input: CouponWarehouseStatement) => {
          const native = await job(input, true),
            count = BigInt(
              z
                .object({
                  statistics: z.object({
                    query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
                  }),
                })
                .parse(native.metadata).statistics.query.totalBytesProcessed,
            );
          maxBytes = count > maxBytes ? count : maxBytes;
          if (count > 1000000n) throw Error('SYNTHETIC_BUDGET');
          estimated = true;
          return count;
        },
        execute: async (input: CouponWarehouseStatement) => {
          const native = await job(input, false);
          try {
            const [rows, next, response] = await native.getQueryResults({
              autoPaginate: false,
              maxResults: 2,
              maxApiCalls: 1,
              timeoutMs: 10000,
            });
            if (next || !response?.jobComplete || response.pageToken)
              throw Error('SYNTHETIC_INCOMPLETE');
            executed = true;
            return rows;
          } catch (error) {
            void native.cancel().catch(() => undefined);
            throw error;
          }
        },
      };
      const unsupported =
        scenario !== 'literal' &&
        scenario !== 'zero' &&
        !(scenario === 'incomplete' && mode === 'read');
      try {
        const result =
          mode === 'candidate'
            ? await sealCouponWarehousePublication(
                f.capture,
                couponWarehouseCapture(
                  f.options,
                  { sourceKey: f.authority.sourceKey },
                  { query, clock: () => f.now },
                ),
                f.authority,
                { clock: () => f.now },
              )
            : await couponBigQueryHistory(f.options, f.authority, {
                query,
                clock: () => f.now,
              }).read(f.scope, { witness: f.witness, signal: new AbortController().signal });
        if (unsupported) throw Error('UNSAFE_SYNTHETIC_ACCEPTANCE');
        if (
          mode === 'read' &&
          'globalUsage' in result &&
          result.globalUsage !== f.facts.globalUsage
        )
          throw Error('SYNTHETIC_FACTS_MISMATCH');
      } catch (error) {
        if (
          !unsupported ||
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ORDER_IMPORT_COUPON_PUBLICATION_WAREHOUSE_INCOMPLETE' &&
            estimated &&
            executed
          )
        )
          throw error;
      }
      passed++;
    }
  const sample = warehouseFixture();
  if (
    !couponWarehouseSql(
      sample.options,
      sample.scope,
      sample.capture.controlHeadHash,
    ).statement.includes('order_multipliers')
  )
    throw Error('MISSING_SOURCE_JOIN');
  process.stdout.write(
    JSON.stringify({
      resource: 'csv-coupon-history',
      passed,
      syntheticOnly: true,
      sourceRowsRead: 0,
      warehouseWrites: 0,
      maxEstimatedBytes: maxBytes.toString(),
    }) + '\n',
  );
}
void main().catch(() => {
  process.stderr.write(
    JSON.stringify({ resource: 'csv-coupon-history', stage, code: 'VALIDATION_FAILED' }) + '\n',
  );
  process.exitCode = 1;
});
