/** Execute only literal CTE SELECTs on the authorized readonly SA. */
import { BigQuery } from '@google-cloud/bigquery';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { generationFixtureSql } from './generation-bigquery-fixtures.js';
import { generationFixture } from '../../tests/legacy-import-coupon-history/generation-fixtures.js';
import { normalizeWarehouseParameters } from '../../src/modules/warehouse-parameters.js';
import { couponGenerationHistory } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-runtime.js';
import {
  couponGenerationCandidate,
  qualifyGenerationPublication,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-candidate.js';
import type { GenerationStatement } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-query.js';
let stage = 'configuration';
async function main() {
  if (!process.argv.includes('--synthetic') || !process.env.BQ_COUPON_HISTORY_VALIDATION_KEY_FILE)
    throw Error('EXPLICIT_SYNTHETIC_REQUIRED');
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
      'chunk',
      'same-day-hour',
      'tamper',
      'missing-log',
      'orphan',
      'mixed',
      'missing',
    ] as const) {
      const f = generationFixture(
        scenario === 'zero' || scenario === 'chunk',
        scenario === 'chunk' ? 1002 : 0,
      );
      let estimated = false,
        executed = false;
      const statement = (input: GenerationStatement) =>
        generationFixtureSql(input, f, (rows) => {
          if (scenario === 'tamper') rows.orders[0]!.order_status = 7;
          if (scenario === 'same-day-hour')
            rows.orders[0]!.created_at = f.scope.sourceDay + ' 23:59:59';
          if (scenario === 'missing-log') rows.logs.pop();
          if (scenario === 'orphan')
            rows.controls = rows.controls.filter((v) => v.coupon_id !== '999');
          if (scenario === 'mixed') rows.logs[0]!.head_hash = '0'.repeat(64);
          if (scenario === 'missing') rows.manifests = [];
        });
      const query = {
        estimate: async (input: GenerationStatement) => {
          stage = mode + '-' + scenario + '-estimate';
          const [job] = await client.createQueryJob({
            query: statement(input),
            params: normalizeWarehouseParameters(input.params, input.types),
            types: input.types,
            dryRun: true,
            useLegacySql: false,
            useQueryCache: false,
            maximumBytesBilled: '1000000',
            jobTimeoutMs: 10000,
            location: 'asia-south1',
          });
          const count = BigInt(
            z
              .object({
                statistics: z.object({
                  query: z.object({ totalBytesProcessed: z.string().regex(/^\d+$/) }),
                }),
              })
              .parse(job.metadata).statistics.query.totalBytesProcessed,
          );
          if (count > 1000000n) throw Error('BUDGET');
          maxBytes = count > maxBytes ? count : maxBytes;
          estimated = true;
          return count;
        },
        execute: async (input: GenerationStatement) => {
          stage = mode + '-' + scenario + '-select';
          const [job] = await client.createQueryJob({
            query: statement(input),
            params: normalizeWarehouseParameters(input.params, input.types),
            types: input.types,
            useLegacySql: false,
            useQueryCache: false,
            maximumBytesBilled: '1000000',
            jobTimeoutMs: 10000,
            location: 'asia-south1',
          });
          try {
            const [rows, next, response] = await job.getQueryResults({
              autoPaginate: false,
              maxResults: 2,
              maxApiCalls: 1,
              timeoutMs: 10000,
            });
            if (next || !response?.jobComplete || response.pageToken) throw Error('INCOMPLETE');
            executed = true;
            return rows;
          } catch (error) {
            void job.cancel().catch(() => undefined);
            throw error;
          }
        },
      };
      const rejected = ['tamper', 'missing-log', 'orphan', 'mixed', 'missing'].includes(scenario);
      try {
        if (mode === 'candidate') {
          const pub = await qualifyGenerationPublication(
            f.capture,
            couponGenerationCandidate(
              f.options,
              { sourceKey: f.authority.sourceKey },
              { query, clock: () => f.now },
            ),
            f.authority,
            f.options.comparisonFingerprint!,
            { signal: new AbortController().signal, clock: () => f.now },
          );
          if (pub.seal !== f.publication.seal) throw Error('PUBLICATION_MISMATCH');
        } else {
          const reader = couponGenerationHistory(f.options, f.authority, {
              query,
              clock: () => f.now,
            }),
            a = await reader.read(f.operation, {
              witness: f.witness,
              signal: new AbortController().signal,
            });
          const b = await reader.read(
            {
              ...f.operation,
              operationId: randomUUID(),
              requestHash: '1'.repeat(64),
              planHash: '2'.repeat(64),
            },
            { witness: f.witness, signal: new AbortController().signal },
          );
          if (
            a.signature === b.signature ||
            a.publication.sourceCaptureHash !== f.capture.signature ||
            b.publication.seal !== f.publication.seal
          )
            throw Error('BINDING_MISMATCH');
        }
        if (rejected) throw Error('UNSAFE_ACCEPTANCE');
      } catch (error) {
        if (
          !rejected ||
          !estimated ||
          !executed ||
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_INCOMPLETE'
          )
        )
          throw error;
      }
      passed++;
    }
  process.stdout.write(
    JSON.stringify({
      resource: 'coupon-generations',
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
    JSON.stringify({ resource: 'coupon-generations', stage, code: 'VALIDATION_FAILED' }) + '\n',
  );
  process.exitCode = 1;
});
