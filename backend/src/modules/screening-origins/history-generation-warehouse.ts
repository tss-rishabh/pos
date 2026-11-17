import { createHash } from 'node:crypto';
import type { Job, Query } from '@google-cloud/bigquery';
import { z } from 'zod';
import { normalizeWarehouseParameters } from '../warehouse-parameters.js';
import { qualifiedWarehouseTable, type BoundedSelectPort } from '../warehouse/bounded-select.js';
import { originDigest, originError, originHashSchema, sameOriginHash } from './contracts.js';
import {
  originHistoryCandidateSchema,
  originHistoryCaptureSchema,
  originHistoryFacts,
  originHistoryPublicationSchema,
  originHistoryProjectionHash,
  sameHistoryWitness,
  type OriginHistorySnapshot,
  type OriginHistoryPublication,
} from './history-contracts.js';

const ownedTable = qualifiedWarehouseTable.refine((value) =>
  value.split('.')[2]!.startsWith('pos_origin_history_'),
);
export const originHistoryWarehouseOptionsSchema = z
  .object({
    orders: ownedTable,
    manifests: ownedTable,
    counts: ownedTable,
    publications: ownedTable,
    maxBytes: z.number().int().min(1).max(1000000000).default(50000000),
    timeoutMs: z.number().int().min(100).max(25000).default(8000),
  })
  .strict()
  .refine(
    (value) =>
      new Set([value.orders, value.manifests, value.counts, value.publications]).size === 4,
  );
export type OriginHistoryWarehouseOptions = z.infer<typeof originHistoryWarehouseOptionsSchema>;
export const originHistoryWritePlanSchema = z
  .object({
    kind: z.enum(['materialize', 'publish']),
    jobId: z.string().regex(/^pos_origin_hist_(?:materialize|publish)_[a-f0-9]{64}$/),
    sql: z.string().max(40000),
    preflight: z.string().max(40000),
    params: z.record(z.string(), z.union([z.string().max(9000000), z.number().safe().int()])),
    types: z.record(z.string(), z.string().max(30)),
    hash: originHashSchema,
    authHash: originHashSchema,
  })
  .strict();
export type OriginHistoryWritePlan = z.infer<typeof originHistoryWritePlanSchema>;
const plans = new WeakSet<OriginHistoryWritePlan>();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const originHistoryWriteReplySchema = z
  .object({
    status: z.enum(['unknown', 'pending', 'failed', 'succeeded']),
    jobId: z.string().max(128),
    queryHash: originHashSchema,
    evidenceHash: originHashSchema,
  })
  .strict();
export type OriginHistoryWriteReply = z.infer<typeof originHistoryWriteReplySchema>;
export interface OriginHistoryWriter {
  preflight(plan: OriginHistoryWritePlan, signal: AbortSignal): Promise<void>;
  start(plan: OriginHistoryWritePlan, signal: AbortSignal): Promise<OriginHistoryWriteReply>;
  read(plan: OriginHistoryWritePlan, signal: AbortSignal): Promise<OriginHistoryWriteReply>;
}

function cohort(options: OriginHistoryWarehouseOptions) {
  return `WITH scoped AS (SELECT order_id AS id,status,flag FROM \`${options.orders}\` WHERE scope_shard=@shard AND customer_id=@customer AND generation_id=@generation),
facts AS (SELECT CAST(COUNT(*) AS STRING) AS orderRows,CAST(COUNT(DISTINCT id) AS STRING) AS uniqueOrders,
CAST(COUNTIF(status IS NOT NULL AND status!='4') AS STRING) AS welcomeCount,
CAST(COUNTIF(status='3' AND flag='18') AS STRING) AS appCashbackCount,
CAST(COUNTIF(status='3' AND flag IS NOT NULL AND flag!='18') AS STRING) AS webCashbackCount,
LOWER(TO_HEX(SHA256(TO_JSON_STRING(ARRAY(SELECT AS STRUCT flag,id,status FROM scoped ORDER BY LENGTH(id),id))))) AS rowsHash FROM scoped)`;
}
export function originHistoryCandidate(
  options: OriginHistoryWarehouseOptions,
  select: BoundedSelectPort,
) {
  return {
    async read(snapshot: OriginHistorySnapshot, generationId: string, signal: AbortSignal) {
      const c = snapshot.capture;
      const sql =
        cohort(options) +
        `, manifest AS (SELECT document FROM \`${options.manifests}\` WHERE scope_shard=@shard AND customer_id=@customer AND generation_id=@generation)
SELECT TO_JSON_STRING(STRUCT(ARRAY(SELECT PARSE_JSON(document) FROM manifest LIMIT 2) AS manifests,ARRAY(SELECT AS STRUCT * FROM facts) AS facts)) AS document`;
      const raw = JSON.parse(
        await select.read(
          {
            sql,
            params: {
              shard: String(BigInt(c.customerId) % 1024n),
              customer: c.customerId,
              generation: generationId,
            },
            types: { shard: 'INT64', customer: 'STRING', generation: 'STRING' },
          },
          signal,
        ),
      ) as unknown;
      const parsed = z
          .object({
            manifests: z.array(originHistoryCaptureSchema).length(1),
            facts: z.array(z.object(originHistoryFacts).strict()).length(1),
          })
          .strict()
          .parse(raw),
        actual = parsed.manifests[0]!;
      if (
        actual.signature !== c.signature ||
        !sameHistoryWitness(actual.witness, c.witness) ||
        JSON.stringify(actual) !== JSON.stringify(c)
      )
        throw originError('SCREENING_ORIGIN_HISTORY_CANDIDATE_INVALID');
      return originHistoryCandidateSchema.parse({
        contract: 'pos-screening-origin-history-candidate-v1',
        customerId: c.customerId,
        witness: c.witness,
        sourceCaptureHash: c.signature,
        generationId,
        projectionHash: originHistoryProjectionHash,
        complete: true,
        reader: 'bigquery',
        sourceCompleteThrough: c.capturedAt,
        ...parsed.facts[0]!,
      });
    },
  };
}
export function originHistoryWritePlan(
  snapshot: OriginHistorySnapshot,
  options: OriginHistoryWarehouseOptions,
  journalKey: string,
  generationId: string,
  publication?: OriginHistoryPublication,
): OriginHistoryWritePlan {
  originHistoryWarehouseOptionsSchema.parse(options);
  originHashSchema.parse(generationId);
  const c = snapshot.capture,
    kind = publication ? 'publish' : 'materialize',
    params: Record<string, string | number> = {
      generation: generationId,
      customer: c.customerId,
      shard: String(BigInt(c.customerId) % 1024n),
      revision: c.witness.revision,
      schema: c.witness.sourceSchema,
      server: c.witness.sourceServerUuid,
      writers: c.witness.writersHash,
      capture: JSON.stringify(c),
    },
    types: Record<string, string> = Object.fromEntries(
      Object.keys(params).map((key) => [key, key === 'shard' ? 'INT64' : 'STRING']),
    );
  let sql: string;
  if (!publication) {
    params.rows = JSON.stringify(snapshot.rows);
    types.rows = 'STRING';
    sql = `BEGIN TRANSACTION;
ASSERT (SELECT COUNT(*) FROM \`${options.manifests}\` WHERE scope_shard=@shard AND customer_id=@customer AND generation_id=@generation)=0 AS 'ORIGIN_HISTORY_GENERATION_EXISTS';
INSERT INTO \`${options.orders}\`(scope_shard,generation_id,customer_id,order_id,status,flag)
SELECT @shard,@generation,@customer,JSON_VALUE(row,'$.id'),JSON_VALUE(row,'$.status'),JSON_VALUE(row,'$.flag') FROM UNNEST(JSON_QUERY_ARRAY(@rows)) AS row;
INSERT INTO \`${options.manifests}\`(scope_shard,generation_id,customer_id,document) VALUES(@shard,@generation,@customer,@capture);
COMMIT TRANSACTION;`;
  } else {
    originHistoryPublicationSchema.parse(publication);
    params.publication = JSON.stringify(publication);
    types.publication = 'STRING';
    sql = `BEGIN TRANSACTION;
ASSERT (SELECT COUNT(*) FROM \`${options.manifests}\` WHERE scope_shard=@shard AND customer_id=@customer AND generation_id=@generation AND document=@capture)=1 AS 'ORIGIN_HISTORY_SOURCE_MISMATCH';
ASSERT (SELECT COUNT(*) FROM \`${options.publications}\` WHERE scope_shard=@shard AND customer_id=@customer AND generation_id=@generation)=0 AS 'ORIGIN_HISTORY_PUBLICATION_EXISTS';
CREATE TEMP TABLE actual AS ${cohort(options)} SELECT * FROM facts;
ASSERT (SELECT COUNT(*) FROM actual WHERE orderRows=JSON_VALUE(@publication,'$.orderRows') AND uniqueOrders=JSON_VALUE(@publication,'$.uniqueOrders')
AND welcomeCount=JSON_VALUE(@publication,'$.welcomeCount') AND appCashbackCount=JSON_VALUE(@publication,'$.appCashbackCount')
AND webCashbackCount=JSON_VALUE(@publication,'$.webCashbackCount') AND rowsHash=JSON_VALUE(@publication,'$.rowsHash'))=1 AS 'ORIGIN_HISTORY_FACTS_MISMATCH';
INSERT INTO \`${options.counts}\`(scope_shard,generation_id,customer_id,head_revision,source_schema,source_server_uuid,writers_hash,order_rows,unique_orders,welcome_count,app_cashback_count,web_cashback_count,rows_hash)
SELECT @shard,@generation,@customer,@revision,@schema,@server,@writers,CAST(orderRows AS INT64),CAST(uniqueOrders AS INT64),CAST(welcomeCount AS INT64),CAST(appCashbackCount AS INT64),CAST(webCashbackCount AS INT64),rowsHash FROM actual;
INSERT INTO \`${options.publications}\`(scope_shard,generation_id,customer_id,head_revision,source_schema,source_server_uuid,writers_hash,document)
VALUES(@shard,@generation,@customer,@revision,@schema,@server,@writers,@publication);
COMMIT TRANSACTION;`;
  }
  const used = new Set([...sql.matchAll(/@([a-zA-Z][a-zA-Z0-9_]*)/g)].map((match) => match[1]!));
  for (const name of Object.keys(params))
    if (!used.has(name)) {
      delete params[name];
      delete types[name];
    }
  const preflight =
      cohort(options) +
      ` SELECT TO_JSON_STRING(STRUCT((SELECT COUNT(*) FROM facts) AS facts,(SELECT COUNT(*) FROM \`${options.manifests}\` WHERE scope_shard=@shard AND customer_id=@customer AND generation_id=@generation) AS manifests,(SELECT COUNT(*) FROM \`${options.publications}\` WHERE scope_shard=@shard AND customer_id=@customer AND generation_id=@generation) AS publications)) AS document`,
    body = {
      kind,
      jobId: 'pos_origin_hist_' + kind + '_' + generationId,
      sql,
      preflight,
      params,
      types,
    };
  const plan = originHistoryWritePlanSchema.parse({
    ...body,
    hash: hash(body),
    authHash: originDigest(journalKey, 'history-write-plan', body),
  });
  plans.add(plan);
  return Object.freeze(plan);
}
export function restoreOriginHistoryWritePlan(input: unknown, key: string) {
  const plan = originHistoryWritePlanSchema.parse(input),
    { hash: seal, authHash, ...body } = plan;
  if (
    hash(body) !== seal ||
    !sameOriginHash(authHash, originDigest(key, 'history-write-plan', body))
  )
    throw originError('SCREENING_ORIGIN_HISTORY_WRITE_PLAN_INVALID');
  plans.add(plan);
  return plan;
}
export function originHistoryWriter(options: {
  contract: 'pos-screening-origin-history-warehouse-writer-v1';
  writerIdentity: string;
  readerIdentity: string;
  maxBytes: number;
  timeoutMs: number;
  clientFactory: () => {
    createQueryJob(query: Query): Promise<readonly [Job, ...unknown[]]>;
    job(id: string, options: { location: string }): Job;
  };
}): OriginHistoryWriter {
  if (
    options.contract !== 'pos-screening-origin-history-warehouse-writer-v1' ||
    !options.writerIdentity ||
    !options.readerIdentity ||
    options.writerIdentity.toLowerCase() === options.readerIdentity.toLowerCase() ||
    options.writerIdentity.toLowerCase() ===
      'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com' ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 1000000000 ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 25000
  )
    throw originError('SCREENING_ORIGIN_HISTORY_WRITER_REQUIRED');
  let client: ReturnType<typeof options.clientFactory> | undefined;
  // A successful readonly estimate authorizes one in-process dispatch of this
  // exact authenticated plan. Recovery never obtains or consumes this witness.
  const preflighted = new WeakMap<OriginHistoryWritePlan, string>();
  const reply = (plan: OriginHistoryWritePlan, status: OriginHistoryWriteReply['status']) => {
    const body = { status, jobId: plan.jobId, queryHash: plan.hash };
    return { ...body, evidenceHash: hash(body) };
  };
  function verified(plan: OriginHistoryWritePlan, raw: unknown) {
    const parsed = z
      .object({
        jobReference: z.object({
          projectId: z.literal('tssgcp2025'),
          location: z.literal('asia-south1'),
          jobId: z.literal(plan.jobId),
        }),
        configuration: z.object({
          query: z.object({
            query: z.literal(plan.sql),
            useLegacySql: z.literal(false),
            queryParameters: z
              .array(
                z.object({
                  name: z.string(),
                  parameterType: z.object({ type: z.string() }),
                  parameterValue: z.object({ value: z.string() }),
                }),
              )
              .max(30),
          }),
        }),
        statistics: z.object({ query: z.object({ statementType: z.literal('SCRIPT') }) }),
        status: z.object({
          state: z.enum(['PENDING', 'RUNNING', 'DONE']),
          errorResult: z.unknown().optional(),
          errors: z.array(z.unknown()).optional(),
        }),
      })
      .safeParse(raw);
    if (!parsed.success) return reply(plan, 'unknown');
    const parameters = parsed.data.configuration.query.queryParameters;
    if (
      parameters.length !== Object.keys(plan.params).length ||
      new Set(parameters.map((value) => value.name)).size !== parameters.length ||
      parameters.some(
        (value) =>
          value.parameterType.type !== plan.types[value.name] ||
          value.parameterValue.value !== String(plan.params[value.name]),
      )
    )
      return reply(plan, 'unknown');
    const status = parsed.data.status;
    return reply(
      plan,
      status.state !== 'DONE'
        ? 'pending'
        : status.errorResult || status.errors?.length
          ? 'failed'
          : 'succeeded',
    );
  }
  async function bounded<T>(work: Promise<T>, signal: AbortSignal, onLate?: (value: T) => void) {
    let expired = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      abort: (() => void) | undefined;
    const watch = work.then((value) => {
      if (expired) onLate?.(value);
      return value;
    });
    try {
      return await Promise.race([
        watch,
        new Promise<never>((_accept, reject) => {
          abort = () => {
            expired = true;
            reject(originError('SCREENING_ORIGIN_HISTORY_WRITER_UNKNOWN'));
          };
          timer = setTimeout(abort, options.timeoutMs);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
  return {
    async preflight(plan, signal) {
      if (!plans.has(plan)) throw originError('SCREENING_ORIGIN_HISTORY_WRITE_PLAN_INVALID');
      preflighted.delete(plan);
      signal.throwIfAborted();
      client ??= options.clientFactory();
      const fingerprint = hash(plan),
        names = new Set(
          [...plan.preflight.matchAll(/@([a-zA-Z][a-zA-Z0-9_]*)/g)].map((match) => match[1]!),
        ),
        estimateParams = Object.fromEntries(
          Object.entries(plan.params).filter(([key]) => names.has(key)),
        ),
        estimateTypes = Object.fromEntries(
          Object.entries(plan.types).filter(([key]) => names.has(key)),
        );
      const [estimated] = await bounded(
        client.createQueryJob({
          query: plan.preflight,
          params: normalizeWarehouseParameters(estimateParams, estimateTypes),
          types: estimateTypes,
          useLegacySql: false,
          useQueryCache: false,
          maximumBytesBilled: String(options.maxBytes),
          jobTimeoutMs: options.timeoutMs,
          location: 'asia-south1',
          dryRun: true,
        }),
        signal,
      );
      const estimate = z
        .object({
          statistics: z.object({
            query: z.object({
              totalBytesProcessed: z.string().regex(/^\d{1,20}$/),
              referencedTables: z
                .array(
                  z.object({
                    projectId: z.literal('tssgcp2025'),
                    datasetId: z.literal('tss_mysql_raw_layer'),
                  }),
                )
                .min(1)
                .max(100),
              referencedRoutines: z.array(z.unknown()).max(0).optional(),
            }),
          }),
        })
        .safeParse(estimated.metadata);
      if (
        !estimate.success ||
        BigInt(estimate.data.statistics.query.totalBytesProcessed) > BigInt(options.maxBytes)
      )
        throw originError('SCREENING_ORIGIN_HISTORY_WRITE_BUDGET');
      signal.throwIfAborted();
      if (hash(plan) !== fingerprint)
        throw originError('SCREENING_ORIGIN_HISTORY_WRITE_PLAN_INVALID');
      preflighted.set(plan, fingerprint);
    },
    async start(plan, signal) {
      const witnessed = preflighted.get(plan);
      preflighted.delete(plan);
      if (!plans.has(plan) || witnessed === undefined || witnessed !== hash(plan))
        throw originError('SCREENING_ORIGIN_HISTORY_WRITE_PREFLIGHT_REQUIRED');
      try {
        signal.throwIfAborted();
        client ??= options.clientFactory();
        const [job] = await bounded(
          client.createQueryJob({
            query: plan.sql,
            params: normalizeWarehouseParameters(plan.params, plan.types),
            types: plan.types,
            useLegacySql: false,
            useQueryCache: false,
            maximumBytesBilled: String(options.maxBytes),
            jobTimeoutMs: options.timeoutMs,
            location: 'asia-south1',
            jobId: plan.jobId,
            dryRun: false,
            createSession: false,
            labels: { application: 'pos-rewrite', resource: 'origin-history-publisher' },
          }),
          signal,
          (value) => {
            void value[0].cancel().catch(() => undefined);
          },
        );
        return verified(plan, job.metadata);
      } catch {
        return reply(plan, 'unknown');
      }
    },
    async read(plan, signal) {
      if (!plans.has(plan)) throw originError('SCREENING_ORIGIN_HISTORY_WRITE_PLAN_INVALID');
      try {
        client ??= options.clientFactory();
        const [metadata] = await bounded(
          client.job(plan.jobId, { location: 'asia-south1' }).getMetadata(),
          signal,
        );
        return verified(plan, metadata);
      } catch {
        return reply(plan, 'unknown');
      }
    },
  };
}
