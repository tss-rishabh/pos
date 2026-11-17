import { createHash } from 'node:crypto';
import { BigQuery, type Query } from '@google-cloud/bigquery';
import { z } from 'zod';
import { counterError } from './contracts.js';
import { normalizeWarehouseParameters } from '../../warehouse-parameters.js';
import {
  counterGenerationId,
  counterGenerationPlanSchema,
  type CounterGenerationSnapshot,
  type CounterGenerationPlan,
  type CounterGenerationReply,
} from './counter-generation-contracts.js';
import {
  screeningCounterWarehouseStatement,
  parseScreeningCounterWarehouseRows,
} from './warehouse.js';
import type { CounterGenerationOptions } from './counter-generation-options.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const counterGenerationCredentialSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.literal('tssgcp2025'),
  client_email: z
    .email()
    .max(254)
    .refine((v) => v === v.toLowerCase() && v.endsWith('.gserviceaccount.com')),
  private_key: z.string().min(32).max(16000),
});
export type CounterGenerationCredential = z.infer<typeof counterGenerationCredentialSchema>;
export function counterGenerationPlan(
  snapshot: CounterGenerationSnapshot,
  options: Pick<CounterGenerationOptions, 'rows' | 'publications'>,
): CounterGenerationPlan {
  for (const table of [options.rows, options.publications])
    if (!/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]*$/.test(table))
      throw counterError('GENERATION_CONFIGURATION');
  const c = snapshot.capture,
    id = counterGenerationId(snapshot),
    rows = '`' + options.rows + '`',
    pubs = '`' + options.publications + '`';
  const params = {
    day: new Date(c.capturedAt).toISOString().slice(0, 10),
    shard: String(BigInt(c.scope.customerId) % 1024n),
    customer: c.scope.customerId,
    generation: id,
    snapshot: c.snapshotId,
    captureHash: c.signature,
    finished: String(c.finishedAt),
    rows: String(c.rows),
    rowsHash: c.rowsHash,
    rowsJson: JSON.stringify(snapshot.rows),
  };
  const statement = `BEGIN TRANSACTION;
ASSERT NOT EXISTS(SELECT 1 FROM ${pubs} WHERE publication_date=@day AND scope_shard=@shard AND customer_id=@customer AND generation_id=@generation) AS 'COUNTER_GENERATION_EXISTS';
ASSERT NOT EXISTS(SELECT 1 FROM ${rows} WHERE publication_date=@day AND scope_shard=@shard AND customer_id=@customer AND generation_id=@generation) AS 'COUNTER_ROWS_EXIST';
INSERT INTO ${rows}(publication_date,scope_shard,customer_id,generation_id,marker_id,order_id,line_id,included)
SELECT @day,@shard,@customer,@generation,CAST(JSON_VALUE(v,'$.markerId') AS INT64),CAST(JSON_VALUE(v,'$.orderId') AS INT64),CAST(JSON_VALUE(v,'$.lineId') AS INT64),CAST(JSON_VALUE(v,'$.included') AS BOOL) FROM UNNEST(JSON_QUERY_ARRAY(PARSE_JSON(@rowsJson))) v;
INSERT INTO ${pubs}(publication_date,scope_shard,customer_id,contract,generation_id,snapshot_id,source_capture_hash,source_cdc_through_ms,source_complete,marker_rows,rows_hash)
VALUES(@day,@shard,@customer,'pos-screening-counter-bq-candidate-v1',@generation,@snapshot,@captureHash,@finished,TRUE,CAST(@rows AS INT64),@rowsHash);
COMMIT TRANSACTION;`;
  const body = {
    jobId: 'pos_screening_counter_' + id,
    statement,
    preflight: `SELECT COUNT(*) FROM ${pubs} WHERE publication_date=@day AND scope_shard=@shard AND customer_id=@customer AND generation_id=@generation`,
    params,
    types: Object.fromEntries(
      Object.keys(params).map((k) => [
        k,
        k === 'day' ? 'DATE' : ['shard', 'finished'].includes(k) ? 'INT64' : 'STRING',
      ]),
    ),
  };
  return counterGenerationPlanSchema.parse({ ...body, hash: hash(body) });
}
export function verifyCounterGenerationPlan(
  plan: CounterGenerationPlan,
  snapshot: CounterGenerationSnapshot,
  options: Pick<CounterGenerationOptions, 'rows' | 'publications'>,
) {
  const expected = counterGenerationPlan(snapshot, options);
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw counterError('GENERATION_PLAN');
  return expected;
}
function reply(
  plan: CounterGenerationPlan,
  status: CounterGenerationReply['status'],
): CounterGenerationReply {
  return {
    status,
    jobId: plan.jobId,
    queryHash: plan.hash,
    evidenceHash: hash({ status, jobId: plan.jobId, queryHash: plan.hash }),
  };
}
function checkedReply(plan: CounterGenerationPlan, input: unknown) {
  const p = z
    .object({
      jobReference: z.object({
        projectId: z.literal('tssgcp2025'),
        location: z.literal('asia-south1'),
        jobId: z.literal(plan.jobId),
      }),
      configuration: z.object({
        query: z.object({
          query: z.literal(plan.statement),
          useLegacySql: z.literal(false),
          queryParameters: z
            .array(
              z.object({
                name: z.string(),
                parameterType: z.object({ type: z.string() }),
                parameterValue: z.object({ value: z.string() }),
              }),
            )
            .max(20),
        }),
      }),
      statistics: z.object({ query: z.object({ statementType: z.literal('SCRIPT') }) }),
      status: z.object({
        state: z.enum(['PENDING', 'RUNNING', 'DONE']),
        errorResult: z.unknown().optional(),
        errors: z.array(z.unknown()).optional(),
      }),
    })
    .safeParse(input);
  if (!p.success) return reply(plan, 'unknown');
  const parameters = p.data.configuration.query.queryParameters;
  if (
    parameters.length !== Object.keys(plan.params).length ||
    new Set(parameters.map((v) => v.name)).size !== parameters.length ||
    parameters.some(
      (v) =>
        v.parameterType.type !== plan.types[v.name] ||
        v.parameterValue.value !== plan.params[v.name],
    )
  )
    return reply(plan, 'unknown');
  const s = p.data.status;
  return reply(
    plan,
    s.state !== 'DONE' ? 'pending' : s.errorResult || s.errors?.length ? 'failed' : 'succeeded',
  );
}
async function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeout: number,
  onLate?: (value: T) => void,
): Promise<T> {
  let late = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work.then((value) => {
        if (late) onLate?.(value);
        return value;
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () => {
          late = true;
          reject(counterError('GENERATION_UNAVAILABLE'));
        };
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, timeout);
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
export function counterGenerationWarehouse(
  options: CounterGenerationOptions,
  credentials: { reader: CounterGenerationCredential; writer: CounterGenerationCredential },
) {
  const reader = counterGenerationCredentialSchema.parse(credentials.reader),
    writer = counterGenerationCredentialSchema.parse(credentials.writer);
  if (
    reader.client_email === writer.client_email ||
    writer.client_email === 'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com'
  )
    throw counterError('GENERATION_WRITER_REQUIRED');
  function client(c: CounterGenerationCredential) {
    const v = new BigQuery({
      projectId: 'tssgcp2025',
      location: 'asia-south1',
      credentials: { client_email: c.client_email, private_key: c.private_key },
      autoRetry: false,
      maxRetries: 0,
    });
    v.timeout = options.timeoutMs;
    return v;
  }
  let ro: BigQuery | undefined, rw: BigQuery | undefined;
  const readClient = () => (ro ??= client(reader)),
    writeClient = () => (rw ??= client(writer));
  async function estimate(client: BigQuery, query: Query, signal: AbortSignal) {
    const [job] = await bounded(
      client.createQueryJob({ ...query, dryRun: true }),
      signal,
      options.timeoutMs,
    );
    const p = z
      .object({
        statistics: z.object({
          query: z.object({ totalBytesProcessed: z.string().regex(/^[0-9]{1,20}$/) }),
        }),
      })
      .safeParse(job.metadata);
    if (
      !p.success ||
      BigInt(p.data.statistics.query.totalBytesProcessed) > BigInt(options.maxBytes)
    )
      throw counterError('GENERATION_BUDGET');
  }
  const queryOptions = {
    useLegacySql: false,
    useQueryCache: false,
    maximumBytesBilled: String(options.maxBytes),
    jobTimeoutMs: options.timeoutMs,
    location: 'asia-south1',
    createSession: false,
  };
  return {
    async start(plan: CounterGenerationPlan, signal: AbortSignal) {
      let submitted = false;
      try {
        const wanted = new Set(
            [...plan.preflight.matchAll(/@([A-Za-z][A-Za-z0-9_]*)/g)].map((v) => v[1]!),
          ),
          params = Object.fromEntries(Object.entries(plan.params).filter(([k]) => wanted.has(k))),
          types = Object.fromEntries(Object.entries(plan.types).filter(([k]) => wanted.has(k)));
        await estimate(
          writeClient(),
          {
            ...queryOptions,
            query: plan.preflight,
            params: normalizeWarehouseParameters(params, types),
            types,
          },
          signal,
        );
        signal.throwIfAborted();
        submitted = true;
        const [job] = await bounded(
          writeClient().createQueryJob({
            ...queryOptions,
            query: plan.statement,
            params: normalizeWarehouseParameters(plan.params, plan.types),
            types: plan.types,
            jobId: plan.jobId,
            dryRun: false,
            labels: { application: 'pos-rewrite', resource: 'screening-counter-generation' },
          }),
          signal,
          options.timeoutMs,
          (late) => {
            void late[0].cancel().catch(() => undefined);
          },
        );
        return checkedReply(plan, job.metadata);
      } catch {
        return reply(plan, submitted ? 'unknown' : 'failed');
      }
    },
    async recover(plan: CounterGenerationPlan, signal: AbortSignal) {
      try {
        const [metadata] = await bounded(
          writeClient().job(plan.jobId, { location: 'asia-south1' }).getMetadata(),
          signal,
          options.timeoutMs,
        );
        return checkedReply(plan, metadata);
      } catch {
        return reply(plan, 'unknown');
      }
    },
    async verify(snapshot: CounterGenerationSnapshot, signal: AbortSignal) {
      const c = snapshot.capture,
        now = Date.now();
      if (now < c.finishedAt || now - c.capturedAt > 60000) throw counterError('SOURCE_CHANGED');
      const query = {
        ...queryOptions,
        query: screeningCounterWarehouseStatement({
          publicationsView: options.publications,
          rowsView: options.rows,
        }),
        params: {
          customerId: c.scope.customerId,
          shard: String(BigInt(c.scope.customerId) % 1024n),
          snapshotId: c.snapshotId,
          sourceCaptureHash: c.signature,
          from: new Date(c.capturedAt).toISOString().slice(0, 10),
          to: new Date(now).toISOString().slice(0, 10),
        },
        types: {
          customerId: 'STRING',
          shard: 'INT64',
          snapshotId: 'STRING',
          sourceCaptureHash: 'STRING',
          from: 'DATE',
          to: 'DATE',
        },
      };
      const input = { ...query, params: normalizeWarehouseParameters(query.params, query.types) };
      await estimate(readClient(), input, signal);
      signal.throwIfAborted();
      const [job] = await bounded(
        readClient().createQueryJob({ ...input, dryRun: false }),
        signal,
        options.timeoutMs,
        (late) => {
          void late[0].cancel().catch(() => undefined);
        },
      );
      try {
        const [rows] = await bounded(
          job.getQueryResults({
            autoPaginate: false,
            maxResults: 2,
            maxApiCalls: 1,
            timeoutMs: options.timeoutMs,
          }),
          signal,
          options.timeoutMs,
        );
        signal.throwIfAborted();
        return parseScreeningCounterWarehouseRows(rows, c, Date.now());
      } catch (error) {
        void job.cancel().catch(() => undefined);
        throw error;
      }
    },
  };
}
