import { z } from 'zod';
import type { Config } from '../../config.js';
import { identifier } from '../../domain/validation.js';
import { warehouseService } from '../warehouse.js';
import { originCommandSchema, originDigest, originError, originHashSchema, sameOriginHash } from './contracts.js';

const point = z.number().int().safe().positive();
const count = z.string().regex(/^(?:0|[1-9]\d{0,19})$/);
const table = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/);
export const originHistoryWitnessSchema = z.object({
  contract: z.literal('pos-screening-origin-history-head-v1'),
  sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  sourceServerUuid: z.uuid(),
  revision: count,
  writersHash: originHashSchema,
}).strict();
export const originHistoryDocumentSchema = z.object({
  contract: z.literal('pos-screening-origin-history-v1'),
  commandId: z.uuid(), customerId: identifier, requestHash: originHashSchema, cartHash: originHashSchema,
  witness: originHistoryWitnessSchema, generationId: originHashSchema,
  sourceCompleteThrough: point, reader: z.literal('bigquery'), complete: z.literal(true),
  welcomeCount: count, appCashbackCount: count, webCashbackCount: count,
  fetchedAt: point, expiresAt: point, signature: originHashSchema,
}).strict();
export type OriginHistoryDocument = z.infer<typeof originHistoryDocumentSchema>;
const publicationSchema = z.object({
  contract: z.literal('pos-screening-origin-history-publication-v1'),
  generationId: originHashSchema, customerId: identifier, witness: originHistoryWitnessSchema,
  sourceComplete: z.literal(true), sourceCompleteThrough: point, publishedAt: point,
  orderRows: count, uniqueOrders: count, welcomeCount: count, appCashbackCount: count, webCashbackCount: count,
  rowsHash: originHashSchema, signature: originHashSchema,
}).strict();
export interface OriginHistoryOptions {
  contract?: 'pos-screening-origin-history-v1';
  publicationsView?: string;
  countsView?: string;
  publicationKey?: string;
}
export function readOriginHistoryOptions(env: NodeJS.ProcessEnv = process.env): OriginHistoryOptions {
  const selected = env.POS_SCREENING_ORIGIN_HISTORY_CONTRACT;
  if (selected && selected !== 'pos-screening-origin-history-v1') throw originError('SCREENING_ORIGIN_HISTORY_CONFIGURATION');
  for (const value of [env.BQ_SCREENING_ORIGIN_HISTORY_PUBLICATIONS_VIEW, env.BQ_SCREENING_ORIGIN_HISTORY_COUNTS_VIEW])
    if (value && !table.safeParse(value).success) throw originError('SCREENING_ORIGIN_HISTORY_CONFIGURATION');
  return {
    ...(selected ? { contract: selected as OriginHistoryOptions['contract'] } : {}),
    ...(env.BQ_SCREENING_ORIGIN_HISTORY_PUBLICATIONS_VIEW ? { publicationsView: env.BQ_SCREENING_ORIGIN_HISTORY_PUBLICATIONS_VIEW } : {}),
    ...(env.BQ_SCREENING_ORIGIN_HISTORY_COUNTS_VIEW ? { countsView: env.BQ_SCREENING_ORIGIN_HISTORY_COUNTS_VIEW } : {}),
    ...(env.POS_SCREENING_ORIGIN_HISTORY_PUBLICATION_KEY ? { publicationKey: env.POS_SCREENING_ORIGIN_HISTORY_PUBLICATION_KEY } : {}),
  };
}
/** One complete independently published customer cohort, including explicit
 * zero generations. Raw CDC max apply timestamps are not completeness proofs. */
export function originCustomerHistory(
  config: Config,
  options: OriginHistoryOptions,
  sourceProofKey: string,
  warehouse: Pick<ReturnType<typeof warehouseService>, 'queryReport'> = warehouseService(config),
  clock = Date.now,
) {
  return {
    async read(input: {
      command: z.infer<typeof originCommandSchema>;
      commandProof: string;
      witness: z.infer<typeof originHistoryWitnessSchema>;
    }, signal?: AbortSignal): Promise<OriginHistoryDocument> {
      const command = originCommandSchema.parse(input.command);
      const witness = originHistoryWitnessSchema.parse(input.witness);
      if (command.phase !== 'PREPARED' || !sameOriginHash(originDigest(sourceProofKey, 'command', command), input.commandProof))
        throw originError('SCREENING_ORIGIN_HISTORY_SCOPE_CHANGED');
      if (options.contract !== 'pos-screening-origin-history-v1' || !options.countsView || !options.publicationsView ||
          !options.publicationKey || options.publicationKey === sourceProofKey ||
          !table.safeParse(options.countsView).success || !table.safeParse(options.publicationsView).success)
        throw originError('SCREENING_ORIGIN_HISTORY_REQUIRED');
      if (!Number.isSafeInteger(config.BIGQUERY_MAX_BYTES_BILLED) || config.BIGQUERY_MAX_BYTES_BILLED < 1 || config.BIGQUERY_MAX_BYTES_BILLED > 1000000000)
        throw originError('SCREENING_ORIGIN_HISTORY_BUDGET_REQUIRED');
      const before = clock();
      if (signal?.aborted || before >= command.expiresAt) throw originError('SCREENING_ORIGIN_HISTORY_EXPIRED');
      const rows = await warehouse.queryReport(originHistoryStatement(options), {
        customer: command.customerId,
        shard: String(BigInt(command.customerId) % 1024n),
        revision: witness.revision,
        schema: witness.sourceSchema,
        server: witness.sourceServerUuid,
        writers: witness.writersHash,
        from: new Date(before - 60000).toISOString().slice(0, 10),
        to: new Date(before).toISOString().slice(0, 10),
      }, {
        customer: 'STRING', shard: 'INT64', revision: 'STRING', schema: 'STRING', server: 'STRING', writers: 'STRING', from: 'DATE', to: 'DATE',
      }, 'screening-origin-history');
      if (signal?.aborted || rows.length !== 1 || typeof rows[0]?.document !== 'string') throw originError('SCREENING_ORIGIN_HISTORY_UNAVAILABLE');
      let raw: unknown;
      try { raw = JSON.parse(rows[0].document); } catch { throw originError('SCREENING_ORIGIN_HISTORY_UNAVAILABLE'); }
      const result = z.object({
        publications: z.array(publicationSchema).length(1),
        facts: z.array(z.object({ generationId: originHashSchema, customerId: identifier, revision: count,
          orderRows: count, uniqueOrders: count, welcomeCount: count, appCashbackCount: count, webCashbackCount: count, rowsHash: originHashSchema }).strict()).length(1),
      }).strict().parse(raw);
      const publication = result.publications[0]!;
      const facts = result.facts[0]!;
      const { signature, ...unsigned } = publication;
      const now = clock();
      if (!sameOriginHash(originDigest(options.publicationKey, 'history-publication', unsigned), signature) ||
          publication.customerId !== command.customerId || JSON.stringify(publication.witness) !== JSON.stringify(witness) ||
          publication.sourceCompleteThrough > publication.publishedAt || publication.publishedAt > now || now - publication.publishedAt > 60000 ||
          publication.orderRows !== publication.uniqueOrders || facts.generationId !== publication.generationId || facts.customerId !== command.customerId || facts.revision !== witness.revision ||
          (['orderRows','uniqueOrders','welcomeCount','appCashbackCount','webCashbackCount','rowsHash'] as const).some((field) => facts[field] !== publication[field]) ||
          [publication.welcomeCount, publication.appCashbackCount, publication.webCashbackCount].some((value) => BigInt(value) > BigInt(publication.orderRows)))
        throw originError('SCREENING_ORIGIN_HISTORY_UNQUALIFIED');
      const document = {
        contract: 'pos-screening-origin-history-v1' as const, commandId: command.id, customerId: command.customerId,
        requestHash: command.requestHash, cartHash: command.cartHash, witness,
        generationId: publication.generationId, sourceCompleteThrough: publication.sourceCompleteThrough,
        reader: 'bigquery' as const, complete: true as const,
        welcomeCount: publication.welcomeCount, appCashbackCount: publication.appCashbackCount, webCashbackCount: publication.webCashbackCount,
        fetchedAt: now, expiresAt: Math.min(now + 60000, command.expiresAt),
      };
      if (document.expiresAt <= now) throw originError('SCREENING_ORIGIN_HISTORY_EXPIRED');
      return originHistoryDocumentSchema.parse({ ...document, signature: originDigest(sourceProofKey, 'history', document) });
    },
  };
}
export function originHistoryStatement(options: OriginHistoryOptions) {
  const publications = table.parse(options.publicationsView), counts = table.parse(options.countsView);
  return `WITH publication AS (
SELECT document FROM \`${publications}\`
WHERE publication_date BETWEEN @from AND @to AND scope_shard=@shard AND customer_id=@customer
AND head_revision=@revision AND source_schema=@schema AND source_server_uuid=@server AND writers_hash=@writers
), facts AS (
SELECT generation_id AS generationId,customer_id AS customerId,head_revision AS revision,
CAST(order_rows AS STRING) AS orderRows,CAST(unique_orders AS STRING) AS uniqueOrders,
CAST(welcome_count AS STRING) AS welcomeCount,CAST(app_cashback_count AS STRING) AS appCashbackCount,
CAST(web_cashback_count AS STRING) AS webCashbackCount,rows_hash AS rowsHash FROM \`${counts}\`
WHERE publication_date BETWEEN @from AND @to AND scope_shard=@shard AND customer_id=@customer AND head_revision=@revision
)
SELECT TO_JSON_STRING(STRUCT(
ARRAY(SELECT PARSE_JSON(document) FROM publication LIMIT 2) AS publications,
ARRAY(SELECT AS STRUCT * FROM facts LIMIT 2) AS facts)) AS document`;
}
