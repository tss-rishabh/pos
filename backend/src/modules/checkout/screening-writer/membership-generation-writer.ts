import { createHash } from 'node:crypto';
import type { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import { normalizeWarehouseParameters } from '../../warehouse-parameters.js';
import {
  membershipGenerationSchema,
  membershipGenerationPublicationSchema,
  membershipHistoryDigest,
  membershipSelectionHash,
  publicMembershipHistoryError,
} from './membership-history.js';
import type {
  MembershipGenerationArtifact,
  MembershipGenerationWritePort,
} from './membership-generation.js';

export const membershipGenerationWriterContract = 'pos-public-membership-generation-writer-v1';
const target = z.string().regex(/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/);
function plan(
  artifact: MembershipGenerationArtifact,
  table: string,
  sourceKey: string,
  publicationKey: string,
) {
  target.parse(table);
  const capture = membershipGenerationSchema.parse(artifact.sourceCapture),
    publication = membershipGenerationPublicationSchema.parse(artifact.publication),
    { signature: sourceSignature, ...source } = capture,
    { signature: publicationSignature, ...published } = publication;
  if (
    sourceSignature !== membershipHistoryDigest('generation', source, sourceKey) ||
    publicationSignature !== membershipHistoryDigest('publication', published, publicationKey) ||
    publication.sourceCaptureHash !== sourceSignature ||
    publication.generationId !== capture.generationId ||
    membershipSelectionHash(artifact.warehouseSelection) !== publication.warehouseSelectionHash ||
    publication.warehouseSelectionHash !== capture.selectionHash
  )
    throw publicMembershipHistoryError();
  const statement = `BEGIN TRANSACTION;
ASSERT NOT EXISTS(SELECT 1 FROM \`${table}\` WHERE DATE(as_of)=DATE(@asOf) AND customer_id=@customer AND configuration_hash=@configuration AND generation_id=@generation) AS "MEMBER_GENERATION_EXISTS";
INSERT INTO \`${table}\` (scope_shard,contract,customer_id,source_time_zone,configuration_hash,generation_id,as_of,cutoff,source_capture,publication,warehouse_selection,published_at)
VALUES(@shard,@contract,@customer,@zone,@configuration,@generation,@asOf,@cutoff,PARSE_JSON(@capture),PARSE_JSON(@publication),PARSE_JSON(@selection),TIMESTAMP_MILLIS(@publishedAt));
COMMIT TRANSACTION;`;
  const params = {
    shard: Number(BigInt(capture.customerId) % 1024n),
    contract: publication.contract,
    customer: capture.customerId,
    zone: capture.sourceTimeZone,
    configuration: capture.configurationHash,
    generation: capture.generationId,
    asOf: capture.asOf,
    cutoff: capture.cutoff,
    capture: JSON.stringify(capture),
    publication: JSON.stringify(publication),
    selection: JSON.stringify(artifact.warehouseSelection),
    publishedAt: publication.publishedAt,
  };
  if (Buffer.byteLength(JSON.stringify(params)) > 3000000) throw publicMembershipHistoryError();
  const types: Record<string, string> = Object.fromEntries(
    Object.keys(params).map((key) => [
      key,
      ['shard', 'publishedAt'].includes(key)
        ? 'INT64'
        : ['asOf', 'cutoff'].includes(key)
          ? 'DATETIME'
          : 'STRING',
    ]),
  );
  const value = {
    jobId: 'pos_public_member_gen_' + capture.generationId,
    statement,
    params,
    types,
  };
  return { ...value, hash: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}
/** Purpose-bound append-only publisher. The SDK client must have an explicitly
 * configured independent writer identity; no ADC selection occurs here. */
export function publicMembershipGenerationWriter(options: {
  contract: typeof membershipGenerationWriterContract;
  table: string;
  sourceKey: string;
  publicationKey: string;
  writerIdentity: string;
  readerIdentity: string;
  maximumBytes: number;
  timeoutMs: number;
  client: BigQuery;
}): MembershipGenerationWritePort {
  if (
    options.contract !== membershipGenerationWriterContract ||
    options.writerIdentity === options.readerIdentity ||
    options.writerIdentity.toLowerCase() ===
      'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com' ||
    !z.email().safeParse(options.writerIdentity).success ||
    !z.email().safeParse(options.readerIdentity).success ||
    !Number.isSafeInteger(options.maximumBytes) ||
    options.maximumBytes < 1 ||
    options.maximumBytes > 1000000000 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 10000 ||
    options.client.projectId !== 'tssgcp2025' ||
    options.client.location !== 'asia-south1'
  )
    throw publicMembershipHistoryError();
  target.parse(options.table);
  const create = (value: MembershipGenerationArtifact) =>
    plan(value, value.publicationTable, options.sourceKey, options.publicationKey);
  async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          stop = () => reject(publicMembershipHistoryError());
          timer = setTimeout(stop, options.timeoutMs);
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (stop) signal.removeEventListener('abort', stop);
    }
  }
  function metadata(
    expected: ReturnType<typeof create>,
    input: unknown,
  ): 'unknown' | 'pending' | 'succeeded' | 'failed' {
    const parsed = z
      .object({
        jobReference: z.object({
          projectId: z.literal('tssgcp2025'),
          location: z.literal('asia-south1'),
          jobId: z.literal(expected.jobId),
        }),
        configuration: z.object({
          query: z.object({
            query: z.literal(expected.statement),
            useLegacySql: z.literal(false),
            maximumBytesBilled: z.string().optional(),
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
        }),
      })
      .safeParse(input);
    if (!parsed.success) return 'unknown';
    const query = parsed.data.configuration.query,
      parameters = query.queryParameters,
      expectedParams: Record<string, unknown> = expected.params;
    if (
      parameters.length !== Object.keys(expected.params).length ||
      new Set(parameters.map((row) => row.name)).size !== parameters.length ||
      parameters.some(
        (row) =>
          expected.types[row.name] !== row.parameterType.type ||
          String(expectedParams[row.name]) !== row.parameterValue.value,
      )
    )
      return 'unknown';
    return parsed.data.status.state !== 'DONE'
      ? 'pending'
      : parsed.data.status.errorResult
        ? 'failed'
        : 'succeeded';
  }
  const common = {
    useLegacySql: false,
    useQueryCache: false,
    createSession: false,
    maximumBytesBilled: String(options.maximumBytes),
    jobTimeoutMs: options.timeoutMs,
    location: 'asia-south1',
  };
  return {
    publicationTable: options.table,
    hash: (artifact) => create(artifact).hash,
    async preflight(artifact, signal) {
      const expected = create(artifact);
      const [job] = await bounded(
        options.client.createQueryJob({
          ...common,
          dryRun: true,
          query: `SELECT COUNT(*) FROM \`${artifact.publicationTable}\` WHERE DATE(as_of)=DATE(@asOf) AND customer_id=@customer AND configuration_hash=@configuration AND generation_id=@generation`,
          params: normalizeWarehouseParameters(
            {
              generation: expected.params.generation,
              customer: expected.params.customer,
              configuration: expected.params.configuration,
              asOf: expected.params.asOf,
            },
            { generation: 'STRING', customer: 'STRING', configuration: 'STRING', asOf: 'DATETIME' },
          ),
          types: {
            generation: 'STRING',
            customer: 'STRING',
            configuration: 'STRING',
            asOf: 'DATETIME',
          },
        }),
        signal,
      );
      const value = z
        .object({
          statistics: z.object({
            query: z.object({
              totalBytesProcessed: z.string().regex(/^\d{1,19}$/),
            }),
          }),
        })
        .safeParse(job.metadata);
      if (
        !value.success ||
        BigInt(value.data.statistics.query.totalBytesProcessed) > BigInt(options.maximumBytes)
      )
        throw publicMembershipHistoryError();
      signal.throwIfAborted();
    },
    async start(artifact, signal) {
      const expected = create(artifact);
      if (artifact.publicationTable !== options.table) throw publicMembershipHistoryError();
      try {
        signal.throwIfAborted();
        const [job] = await bounded(
          options.client.createQueryJob({
            ...common,
            jobId: expected.jobId,
            dryRun: false,
            query: expected.statement,
            params: normalizeWarehouseParameters(expected.params, expected.types),
            types: expected.types,
            labels: { application: 'pos-rewrite', resource: 'public-member-generation' },
          }),
          signal,
        );
        return metadata(expected, job.metadata);
      } catch {
        return 'unknown';
      }
    },
    async read(artifact, signal) {
      const expected = create(artifact);
      try {
        const [value] = await bounded(
          options.client.job(expected.jobId, { location: 'asia-south1' }).getMetadata(),
          signal,
        );
        return metadata(expected, value);
      } catch {
        return 'unknown';
      }
    },
  };
}
