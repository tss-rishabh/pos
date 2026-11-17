import { z } from 'zod';
import type { Config } from '../../config.js';
import { identifier } from '../../domain/validation.js';
import {
  boundedWarehouseSelect,
  qualifiedWarehouseTable,
  type BoundedSelectPort,
} from '../warehouse/bounded-select.js';
import {
  originCommandSchema,
  originDigest,
  originError,
  originHashSchema,
  sameOriginHash,
} from './contracts.js';
import {
  originHistoryWitnessSchema,
  originHistoryDocumentSchema,
  originHistoryPublicationSchema,
  originHistoryCount,
  originHistoryKeys,
  originHistoryFacts,
  sameHistoryWitness,
  type OriginHistoryDocument,
} from './history-contracts.js';
import type { OriginHistoryDemandPort } from './history-generation-demand.js';
export { originHistoryWitnessSchema, originHistoryDocumentSchema } from './history-contracts.js';
export type { OriginHistoryDocument } from './history-contracts.js';
export interface OriginHistoryOptions {
  contract?: 'pos-screening-origin-history-v1';
  publicationsView?: string;
  countsView?: string;
  publicationKey?: string;
  maxBytes?: number;
  timeoutMs?: number;
}
export interface OriginHistoryDependencies {
  select?: BoundedSelectPort;
  demand?: OriginHistoryDemandPort;
  clock?: () => number;
}
export function readOriginHistoryOptions(
  env: NodeJS.ProcessEnv = process.env,
): OriginHistoryOptions {
  const parsed = z
    .object({
      contract: z.literal('pos-screening-origin-history-v1').optional(),
      publicationsView: qualifiedWarehouseTable.optional(),
      countsView: qualifiedWarehouseTable.optional(),
      publicationKey: z
        .string()
        .regex(/^[!-~]{32,4096}$/)
        .optional(),
      maxBytes: z.coerce.number().int().min(1).max(1000000000).default(50000000),
      timeoutMs: z.coerce.number().int().min(100).max(25000).default(8000),
    })
    .strict()
    .safeParse({
      contract: env.POS_SCREENING_ORIGIN_HISTORY_CONTRACT || undefined,
      publicationsView: env.BQ_SCREENING_ORIGIN_HISTORY_PUBLICATIONS_VIEW || undefined,
      countsView: env.BQ_SCREENING_ORIGIN_HISTORY_COUNTS_VIEW || undefined,
      publicationKey: env.POS_SCREENING_ORIGIN_HISTORY_PUBLICATION_KEY || undefined,
      maxBytes: env.POS_SCREENING_ORIGIN_HISTORY_MAX_BYTES || undefined,
      timeoutMs: env.POS_SCREENING_ORIGIN_HISTORY_TIMEOUT_MS || undefined,
    });
  if (!parsed.success) throw originError('SCREENING_ORIGIN_HISTORY_CONFIGURATION');
  return parsed.data;
}
/** Generic prepublished customer/head generation -> fresh original-command
 * response. Native historical capture/publishing is not imported or reachable. */
export function originCustomerHistory(
  config: Pick<Config, 'BIGQUERY_MAX_BYTES_BILLED'>,
  options: OriginHistoryOptions,
  sourceProofKey: string,
  dependencies: OriginHistoryDependencies = {},
) {
  const clock = dependencies.clock ?? Date.now;
  const maxBytes = Math.min(options.maxBytes ?? 50000000, config.BIGQUERY_MAX_BYTES_BILLED);
  const select =
    dependencies.select ??
    boundedWarehouseSelect({
      maxBytes,
      timeoutMs: options.timeoutMs ?? 8000,
      maxDocumentBytes: 262144,
      resource: 'origin-first-order-history',
    });
  return {
    async read(
      input: {
        command: z.infer<typeof originCommandSchema>;
        commandProof: string;
        witness: z.infer<typeof originHistoryWitnessSchema>;
      },
      suppliedSignal?: AbortSignal,
    ): Promise<OriginHistoryDocument> {
      const signal = suppliedSignal ?? AbortSignal.timeout(options.timeoutMs ?? 8000),
        command = originCommandSchema.parse(input.command),
        witness = originHistoryWitnessSchema.parse(input.witness);
      if (
        command.phase !== 'PREPARED' ||
        command.orderId !== null ||
        !sameOriginHash(originDigest(sourceProofKey, 'command', command), input.commandProof)
      )
        throw originError('SCREENING_ORIGIN_HISTORY_SCOPE_CHANGED');
      if (
        options.contract !== 'pos-screening-origin-history-v1' ||
        !options.countsView ||
        !options.publicationsView ||
        !options.publicationKey ||
        options.countsView === options.publicationsView
      )
        throw originError('SCREENING_ORIGIN_HISTORY_REQUIRED');
      originHistoryKeys(sourceProofKey, options.publicationKey);
      const before = clock();
      signal.throwIfAborted();
      if (before >= command.expiresAt) throw originError('SCREENING_ORIGIN_HISTORY_EXPIRED');
      const statement = {
        sql: originHistoryStatement(options),
        params: {
          customer: command.customerId,
          shard: String(BigInt(command.customerId) % 1024n),
          revision: witness.revision,
          schema: witness.sourceSchema,
          server: witness.sourceServerUuid,
          writers: witness.writersHash,
        },
        types: {
          customer: 'STRING',
          shard: 'INT64',
          revision: 'STRING',
          schema: 'STRING',
          server: 'STRING',
          writers: 'STRING',
        },
      };
      let raw: unknown;
      try {
        raw = JSON.parse(await select.read(statement, signal)) as unknown;
      } catch {
        signal.throwIfAborted();
        throw originError('SCREENING_ORIGIN_HISTORY_UNAVAILABLE');
      }
      const parsed = z
        .object({
          publications: z.array(originHistoryPublicationSchema).max(2),
          facts: z
            .array(
              z
                .object({
                  generationId: originHashSchema,
                  customerId: identifier,
                  revision: originHistoryCount,
                  ...originHistoryFacts,
                })
                .strict(),
            )
            .max(2),
        })
        .strict()
        .safeParse(raw);
      if (!parsed.success) throw originError('SCREENING_ORIGIN_HISTORY_UNQUALIFIED');
      const { publications, facts } = parsed.data;
      if (!publications.length && !facts.length) {
        try {
          await dependencies.demand?.enqueue(
            {
              commandId: command.id,
              customerId: command.customerId,
              requestHash: command.requestHash,
              cartHash: command.cartHash,
              witness,
            },
            { signal },
          );
        } catch {
          signal.throwIfAborted();
        }
        throw originError('SCREENING_ORIGIN_HISTORY_GENERATION_REQUIRED');
      }
      if (publications.length !== 1 || facts.length !== 1)
        throw originError('SCREENING_ORIGIN_HISTORY_UNQUALIFIED');
      const publication = publications[0]!,
        actual = facts[0]!,
        { signature, ...unsigned } = publication,
        now = clock();
      if (
        !sameOriginHash(
          originDigest(options.publicationKey, 'history-publication', unsigned),
          signature,
        ) ||
        publication.customerId !== command.customerId ||
        !sameHistoryWitness(publication.witness, witness) ||
        publication.sourceCompleteThrough !== publication.capturedAt ||
        publication.capturedAt > publication.publishedAt ||
        publication.publishedAt > now ||
        publication.orderRows !== publication.uniqueOrders ||
        actual.generationId !== publication.generationId ||
        actual.customerId !== command.customerId ||
        actual.revision !== witness.revision ||
        (Object.keys(originHistoryFacts) as (keyof typeof originHistoryFacts)[]).some(
          (field) => actual[field] !== publication[field],
        ) ||
        [publication.welcomeCount, publication.appCashbackCount, publication.webCashbackCount].some(
          (value) => BigInt(value) > BigInt(publication.orderRows),
        )
      )
        throw originError('SCREENING_ORIGIN_HISTORY_UNQUALIFIED');
      signal.throwIfAborted();
      const document = {
        contract: 'pos-screening-origin-history-v1' as const,
        commandId: command.id,
        customerId: command.customerId,
        requestHash: command.requestHash,
        cartHash: command.cartHash,
        witness,
        generationId: publication.generationId,
        sourceCompleteThrough: publication.sourceCompleteThrough,
        reader: 'bigquery' as const,
        complete: true as const,
        welcomeCount: publication.welcomeCount,
        appCashbackCount: publication.appCashbackCount,
        webCashbackCount: publication.webCashbackCount,
        fetchedAt: now,
        expiresAt: Math.min(now + 60000, command.expiresAt),
      };
      if (document.expiresAt <= now) throw originError('SCREENING_ORIGIN_HISTORY_EXPIRED');
      return originHistoryDocumentSchema.parse({
        ...document,
        signature: originDigest(sourceProofKey, 'history', document),
      });
    },
  };
}
export function originHistoryRuntime(
  config: Pick<Config, 'BIGQUERY_MAX_BYTES_BILLED'>,
  environment: NodeJS.ProcessEnv,
  authority: { sourceKey: string },
  dependencies: OriginHistoryDependencies = {},
) {
  const options = readOriginHistoryOptions(environment);
  return options.contract
    ? originCustomerHistory(config, options, authority.sourceKey, dependencies)
    : undefined;
}
export function originHistoryStatement(options: OriginHistoryOptions) {
  const publications = qualifiedWarehouseTable.parse(options.publicationsView),
    counts = qualifiedWarehouseTable.parse(options.countsView);
  return `WITH publication AS (
SELECT document FROM \`${publications}\` WHERE scope_shard=@shard AND customer_id=@customer
AND head_revision=@revision AND source_schema=@schema AND source_server_uuid=@server AND writers_hash=@writers
), facts AS (
SELECT generation_id AS generationId,customer_id AS customerId,head_revision AS revision,
CAST(order_rows AS STRING) AS orderRows,CAST(unique_orders AS STRING) AS uniqueOrders,
CAST(welcome_count AS STRING) AS welcomeCount,CAST(app_cashback_count AS STRING) AS appCashbackCount,
CAST(web_cashback_count AS STRING) AS webCashbackCount,rows_hash AS rowsHash FROM \`${counts}\`
WHERE scope_shard=@shard AND customer_id=@customer AND head_revision=@revision
AND source_schema=@schema AND source_server_uuid=@server AND writers_hash=@writers
)
SELECT TO_JSON_STRING(STRUCT(ARRAY(SELECT PARSE_JSON(document) FROM publication LIMIT 2) AS publications,
ARRAY(SELECT AS STRUCT * FROM facts LIMIT 2) AS facts)) AS document`;
}
