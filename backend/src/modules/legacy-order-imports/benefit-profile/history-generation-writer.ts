import { createHash } from 'node:crypto';
import { BigQuery, type Job, type Query } from '@google-cloud/bigquery';
import { z } from 'zod';
import { benefitDigest } from './crypto.js';
import { equalImportHash } from '../financial-adapter-primitives.js';
import { normalizeWarehouseParameters } from '../../warehouse-parameters.js';
import { generationAccumulator } from './history-generation-projections.js';
import {
  generationWriterContract,
  generationCandidateContract,
  generationPublicationSchema,
  verifyGenerationCapture,
  generationControlsHash,
  generationError,
  type GenerationPublication,
} from './history-generation-contracts.js';
import { requireGenerationOptions, type GenerationOptions } from './history-generation-options.js';
import type { GenerationSourceSnapshot } from './history-generation-source.js';
const plans = new WeakSet<object>(),
  hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface GenerationWritePlan {
  kind: 'materialize' | 'publish';
  jobId: string;
  statement: string;
  preflight: string;
  params: Record<string, string | number>;
  types: Record<string, string>;
  hash: string;
  authHash: string;
}
export const generationWriteReplySchema = z
  .object({
    status: z.enum(['pending', 'unknown', 'succeeded', 'failed']),
    jobId: z.string().regex(/^pos_coupon_gen_(?:materialize|publish)_[a-f0-9]{64}$/),
    queryHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type GenerationWriteReply = z.infer<typeof generationWriteReplySchema>;
export interface GenerationWritePort {
  start(plan: GenerationWritePlan, signal: AbortSignal): Promise<GenerationWriteReply>;
  read(plan: GenerationWritePlan, signal: AbortSignal): Promise<GenerationWriteReply>;
}
export function generationWritePlan(
  snapshot: GenerationSourceSnapshot,
  supplied: GenerationOptions,
  sourceKey: string,
  publication?: GenerationPublication,
  now = Date.now(),
): GenerationWritePlan {
  const options = requireGenerationOptions(supplied, publication ? 'read' : 'candidate'),
    c = verifyGenerationCapture(snapshot.capture, sourceKey, now);
  if (
    generationControlsHash(c.scope, c.generationId, c.snapshotId, snapshot.controls, sourceKey) !==
    c.controlsHash
  )
    throw generationError('CONTROLS');
  const logs = generationAccumulator('log');
  for (const row of snapshot.logs) logs.add(row);
  if (JSON.stringify(logs.finish()) !== JSON.stringify(c.projections.logs))
    throw generationError('PROJECTION');
  const kind: GenerationWritePlan['kind'] = publication ? 'publish' : 'materialize',
    jobId = 'pos_coupon_gen_' + kind + '_' + c.generationId,
    tick = String.fromCharCode(96),
    table = (name: string | undefined) => tick + name + tick;
  if (!publication && (!options.sourceOrdersByCustomer || !options.sourceOrdersByCoupon))
    throw generationError('SOURCE_LAYOUT_REQUIRED', 503);
  const sourceSelect =
    'SELECT id,user_id,coupon_used,order_status,created_at FROM ' +
    table(options.sourceOrdersByCoupon) +
    ' WHERE coupon_used=CAST(@coupon AS INT64) UNION ALL SELECT id,user_id,coupon_used,order_status,created_at FROM ' +
    table(options.sourceOrdersByCustomer) +
    ' WHERE user_id=CAST(@customer AS INT64) AND (coupon_used IS NULL OR coupon_used<>CAST(@coupon AS INT64))';
  const commonColumns =
    'scope_shard,source_day,projection_contract,generation_id,snapshot_id,head_hash';
  const common = '@shard,@sourceDay,@rowsContract,@generation,@snapshot,@headHash';
  const controlColumns =
    'scope_shard,contract,customer_id,coupon_id,configuration_hash,source_day,source_time_zone,generation_id,snapshot_id,capture_hash,head_hash,materialized_at,capture_document';
  const controlValues =
    '@shard,@candidateContract,@customer,@coupon,@configurationHash,@sourceDay,@zone,@generation,@snapshot,@captureHash,@headHash,CURRENT_TIMESTAMP(),@captureDocument';
  const params: Record<string, string | number> = {
    shard: Number(BigInt(c.scope.customerId) % 1024n),
    rowsContract: 'pos-csv-coupon-generation-rows-v1',
    generation: c.generationId,
    snapshot: c.snapshotId,
    headHash: c.headHash,
    customer: c.scope.customerId,
    coupon: c.scope.couponId,
    configurationHash: c.scope.configurationHash,
    sourceDay: c.scope.sourceDay,
    zone: c.scope.sourceTimeZone,
    captureHash: c.signature,
    captureDocument: JSON.stringify(c),
    candidateContract: generationCandidateContract,
    logsJson: JSON.stringify(snapshot.logs),
    controlsJson: JSON.stringify(snapshot.controls),
  };
  let statement: string;
  if (!publication) {
    statement =
      'BEGIN TRANSACTION;\n' +
      'ASSERT NOT EXISTS(SELECT 1 FROM ' +
      table(options.candidates) +
      ' WHERE source_day=@sourceDay AND generation_id=@generation) AS "GENERATION_EXISTS";\n' +
      'ASSERT NOT EXISTS(SELECT 1 FROM ' +
      table(options.orders) +
      ' WHERE source_day=@sourceDay AND generation_id=@generation) AS "GENERATION_ROWS_EXIST";\n' +
      'ASSERT NOT EXISTS(SELECT 1 FROM ' +
      table(options.logs) +
      ' WHERE source_day=@sourceDay AND generation_id=@generation) AS "GENERATION_LOGS_EXIST";\n' +
      'ASSERT NOT EXISTS(SELECT 1 FROM ' +
      table(options.controls) +
      ' WHERE source_day=@sourceDay AND generation_id=@generation) AS "GENERATION_CONTROLS_EXIST";\n' +
      'INSERT INTO ' +
      table(options.orders) +
      ' (' +
      commonColumns +
      ',order_id,user_id,coupon_used,order_status,created_at) SELECT ' +
      common +
      ',CAST(id AS STRING),CAST(user_id AS STRING),CAST(coupon_used AS STRING),order_status,created_at FROM (' +
      sourceSelect +
      ');\n' +
      'INSERT INTO ' +
      table(options.logs) +
      ' (' +
      commonColumns +
      ',log_id,user_id,coupon_id,status,created_at) SELECT ' +
      common +
      ",JSON_VALUE(v,'$.id'),JSON_VALUE(v,'$.userId'),JSON_VALUE(v,'$.couponId'),CAST(JSON_VALUE(v,'$.status') AS INT64),CAST(JSON_VALUE(v,'$.createdAt') AS DATETIME) FROM UNNEST(JSON_QUERY_ARRAY(PARSE_JSON(@logsJson))) v;\n" +
      'INSERT INTO ' +
      table(options.controls) +
      ' (' +
      commonColumns +
      ',coupon_id,present,lot_matches,same_code,no_times_allowed,unique_no_times_allowed) SELECT ' +
      common +
      ",JSON_VALUE(v,'$.couponId'),CAST(JSON_VALUE(v,'$.present') AS BOOL),CAST(JSON_VALUE(v,'$.lotMatches') AS BOOL),CAST(JSON_VALUE(v,'$.sameCode') AS BOOL),JSON_VALUE(v,'$.noTimesAllowed'),JSON_VALUE(v,'$.uniqueNoTimesAllowed') FROM UNNEST(JSON_QUERY_ARRAY(PARSE_JSON(@controlsJson))) v;\n" +
      'INSERT INTO ' +
      table(options.candidates) +
      ' (' +
      controlColumns +
      ',candidate_complete) VALUES(' +
      controlValues +
      ',TRUE);\nCOMMIT TRANSACTION;';
  } else {
    const p = generationPublicationSchema.parse(publication);
    if (
      p.captureHash !== c.signature ||
      p.generationId !== c.generationId ||
      p.headHash !== c.headHash ||
      JSON.stringify(p.scope) !== JSON.stringify(c.scope)
    )
      throw generationError('PUBLICATION');
    Object.assign(params, {
      publicationContract: p.contract,
      publicationDocument: JSON.stringify(p),
      publishedAt: p.publishedAt,
    });
    statement =
      'BEGIN TRANSACTION;\nASSERT NOT EXISTS(SELECT 1 FROM ' +
      table(options.publications) +
      ' WHERE source_day=@sourceDay AND generation_id=@generation) AS "GENERATION_PUBLICATION_EXISTS";\n' +
      'ASSERT (SELECT COUNT(*) FROM ' +
      table(options.candidates) +
      ' WHERE source_day=@sourceDay AND generation_id=@generation AND capture_hash=@captureHash AND head_hash=@headHash AND candidate_complete=TRUE)=1 AS "GENERATION_CANDIDATE_REQUIRED";\n' +
      'INSERT INTO ' +
      table(options.publications) +
      ' (' +
      controlColumns +
      ',publication_document,published_at) SELECT scope_shard,@publicationContract,customer_id,coupon_id,configuration_hash,source_day,source_time_zone,generation_id,snapshot_id,capture_hash,head_hash,materialized_at,capture_document,@publicationDocument,TIMESTAMP_MILLIS(@publishedAt) FROM ' +
      table(options.candidates) +
      ' WHERE source_day=@sourceDay AND generation_id=@generation AND capture_hash=@captureHash AND head_hash=@headHash AND candidate_complete=TRUE;\nCOMMIT TRANSACTION;';
  }
  const preflight =
    kind === 'materialize'
      ? 'SELECT COUNT(1) FROM (' + sourceSelect + ')'
      : 'SELECT COUNT(1) FROM ' +
        table(options.candidates) +
        ' WHERE source_day=@sourceDay AND generation_id=@generation AND capture_hash=@captureHash AND head_hash=@headHash';
  const referenced = new Set(
    [...statement.matchAll(/@([A-Za-z][A-Za-z0-9_]*)/g)].map((v) => v[1]!),
  );
  for (const key of Object.keys(params)) if (!referenced.has(key)) delete params[key];
  const types: Record<string, string> = Object.fromEntries(
    Object.keys(params).map((k) => [
      k,
      ['shard', 'publishedAt'].includes(k) ? 'INT64' : k === 'sourceDay' ? 'DATE' : 'STRING',
    ]),
  );
  if (Buffer.byteLength(JSON.stringify(params)) > 8000000) throw generationError('SOURCE_BYTES');
  const body = {
      kind,
      jobId,
      statement,
      preflight,
      params: Object.freeze(params),
      types: Object.freeze(types),
    },
    queryHash = hash(body),
    plan: GenerationWritePlan = Object.freeze({
      ...body,
      hash: queryHash,
      authHash: benefitDigest(
        'coupon-generation-write-plan',
        { kind, jobId, hash: queryHash },
        sourceKey,
      ),
    });
  plans.add(plan);
  return plan;
}
/** Only the authenticated journal may restore a saved original statement. */
export function restoreGenerationWritePlan(
  value: GenerationWritePlan,
  sourceKey: string,
): GenerationWritePlan {
  const { hash: signature, authHash, ...body } = value;
  if (
    !equalImportHash(
      authHash,
      benefitDigest(
        'coupon-generation-write-plan',
        { kind: value.kind, jobId: value.jobId, hash: signature },
        sourceKey,
      ),
    ) ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    hash(body) !== signature ||
    !/^pos_coupon_gen_(materialize|publish)_[a-f0-9]{64}$/.test(value.jobId) ||
    !value.statement.startsWith('BEGIN TRANSACTION;') ||
    !value.statement.endsWith('COMMIT TRANSACTION;') ||
    /\b(?:DELETE|UPDATE|MERGE|CREATE|ALTER|EXPORT|CALL)\b/i.test(value.statement) ||
    Buffer.byteLength(JSON.stringify(value)) > 9000000
  )
    throw generationError('JOURNAL');
  const frozen = Object.freeze({
    ...value,
    params: Object.freeze({ ...value.params }),
    types: Object.freeze({ ...value.types }),
  });
  plans.add(frozen);
  return frozen;
}
interface WriterJob {
  metadata: unknown;
  getMetadata(): Promise<readonly [unknown, ...unknown[]]>;
  getQueryResults(options: {
    autoPaginate: false;
    maxResults: number;
    maxApiCalls: number;
    timeoutMs: number;
  }): Promise<readonly [unknown, unknown?, unknown?]>;
  cancel(): Promise<unknown>;
}
export interface GenerationWriterClient {
  projectId: string;
  location: string;
  createQueryJob(input: Query): Promise<readonly [WriterJob, ...unknown[]]>;
  job(id: string, options: { location: string }): WriterJob;
}
/** No ADC/default credential path exists here. A separately qualified writer
 * client and distinct identity are mandatory; the readonly SA is never reused. */
export function generationWarehouseWriter(options: {
  contract: typeof generationWriterContract;
  writerIdentity: string;
  readerIdentity: string;
  maxBytes: number;
  timeoutMs: number;
  clientFactory: () => GenerationWriterClient;
}): GenerationWritePort {
  if (
    options.contract !== generationWriterContract ||
    !options.writerIdentity ||
    !options.readerIdentity ||
    options.writerIdentity.trim().toLowerCase() ===
      'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com' ||
    options.writerIdentity.trim().toLowerCase() === options.readerIdentity.trim().toLowerCase() ||
    typeof options.clientFactory !== 'function' ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 1000000000 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 10000
  )
    throw generationError('WRITER_REQUIRED', 503);
  let client: GenerationWriterClient | undefined;
  const get = () => {
    client ??= options.clientFactory();
    if (client.projectId !== 'tssgcp2025' || client.location !== 'asia-south1')
      throw generationError('WRITER_REQUIRED', 503);
    return client;
  };
  const response = (plan: GenerationWritePlan, status: GenerationWriteReply['status']) => ({
    status,
    jobId: plan.jobId,
    queryHash: plan.hash,
    evidenceHash: hash({ status, jobId: plan.jobId, queryHash: plan.hash }),
  });
  function metadata(plan: GenerationWritePlan, value: unknown) {
    const parsed = z
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
      .safeParse(value);
    if (!parsed.success) return response(plan, 'unknown');
    const parameters = parsed.data.configuration.query.queryParameters;
    if (
      parameters.length !== Object.keys(plan.params).length ||
      new Set(parameters.map((v) => v.name)).size !== parameters.length ||
      parameters.some(
        (v) =>
          v.parameterType.type !== plan.types[v.name] ||
          v.parameterValue.value !== String(plan.params[v.name]),
      )
    )
      return response(plan, 'unknown');
    const s = parsed.data.status;
    return response(plan, s.state !== 'DONE' ? 'pending' : s.errorResult ? 'failed' : 'succeeded');
  }
  async function bounded<T>(
    work: Promise<T>,
    signal: AbortSignal,
    onLate?: (v: T) => void,
  ): Promise<T> {
    let expired = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      abort: (() => void) | undefined;
    const watched = work.then((v) => {
      if (expired) onLate?.(v);
      return v;
    });
    try {
      return await Promise.race([
        watched,
        new Promise<never>((_resolve, reject) => {
          abort = () => {
            expired = true;
            reject(generationError('WRITER_UNKNOWN', 503));
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
    async start(plan, signal) {
      if (!plans.has(plan) || signal.aborted) throw generationError('WRITER_PLAN');
      const c = get();
      signal = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]);
      try {
        const input = {
          query: plan.statement,
          params: normalizeWarehouseParameters(plan.params, plan.types),
          types: plan.types,
          useLegacySql: false,
          useQueryCache: false,
          maximumBytesBilled: String(options.maxBytes),
          jobTimeoutMs: options.timeoutMs,
          location: 'asia-south1',
          createSession: false,
        };
        const wanted = new Set(
          [...plan.preflight.matchAll(/@([A-Za-z][A-Za-z0-9_]*)/g)].map((v) => v[1]!),
        );
        const estimateParams = Object.fromEntries(
            Object.entries(plan.params).filter(([key]) => wanted.has(key)),
          ),
          estimateTypes = Object.fromEntries(
            Object.entries(plan.types).filter(([key]) => wanted.has(key)),
          );
        const [estimated] = await bounded(
          c.createQueryJob({
            ...input,
            query: plan.preflight,
            params: normalizeWarehouseParameters(estimateParams, estimateTypes),
            types: estimateTypes,
            dryRun: true,
          }),
          signal,
        );
        const estimate = z
          .object({
            statistics: z.object({
              query: z.object({ totalBytesProcessed: z.string().regex(/^\d{1,19}$/) }),
            }),
          })
          .safeParse(estimated.metadata);
        if (
          !estimate.success ||
          BigInt(estimate.data.statistics.query.totalBytesProcessed) > BigInt(options.maxBytes)
        )
          throw generationError('BUDGET', 503);
        signal.throwIfAborted();
        const [job] = await bounded(
          c.createQueryJob({
            ...input,
            jobId: plan.jobId,
            dryRun: false,
            labels: { application: 'pos-rewrite', resource: 'coupon-generation-publisher' },
          }),
          signal,
          (value) => {
            void value[0].cancel().catch(() => undefined);
          },
        );
        return metadata(plan, job.metadata);
      } catch {
        return response(plan, 'unknown');
      }
    },
    async read(plan, signal) {
      if (!plans.has(plan)) throw generationError('WRITER_PLAN');
      try {
        const job = get().job(plan.jobId, { location: 'asia-south1' }),
          [value] = await bounded(job.getMetadata(), signal);
        return metadata(plan, value);
      } catch {
        return response(plan, 'unknown');
      }
    },
  };
}

/** Concrete Google SDK writer, using explicitly loaded service-account material.
 * There is no ADC/key-file fallback and credentials are never exposed by replies.
 * The private key is consumed only by the lazy SDK factory, after a durable claim. */
export function generationGoogleWarehouseWriter(options: {
  contract: typeof generationWriterContract;
  credentials: {
    type: 'service_account';
    project_id: 'tssgcp2025';
    client_email: string;
    private_key: string;
  };
  readerIdentity: string;
  maxBytes: number;
  timeoutMs: number;
}): GenerationWritePort {
  const parsed = z
    .object({
      type: z.literal('service_account'),
      project_id: z.literal('tssgcp2025'),
      client_email: z
        .email()
        .max(254)
        .refine((v) => v.endsWith('.gserviceaccount.com')),
      private_key: z.string().min(32).max(16000),
    })
    .strict()
    .safeParse(options.credentials);
  if (!parsed.success) throw generationError('WRITER_REQUIRED', 503);
  const credentials = Object.freeze(parsed.data);
  return generationWarehouseWriter({
    ...options,
    writerIdentity: credentials.client_email,
    clientFactory: () => {
      const client = new BigQuery({
        projectId: 'tssgcp2025',
        location: 'asia-south1',
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key,
        },
        autoRetry: false,
        maxRetries: 0,
      });
      client.timeout = options.timeoutMs;
      const wrap = (job: Job): WriterJob => ({
        get metadata() {
          return job.metadata;
        },
        getMetadata: () => job.getMetadata(),
        getQueryResults: (settings) => job.getQueryResults(settings),
        cancel: () => job.cancel(),
      });
      return {
        projectId: 'tssgcp2025',
        location: 'asia-south1',
        async createQueryJob(input) {
          const [job] = await client.createQueryJob(input);
          return [wrap(job)] as const;
        },
        job(id, scope) {
          return wrap(client.job(id, scope));
        },
      };
    },
  });
}
