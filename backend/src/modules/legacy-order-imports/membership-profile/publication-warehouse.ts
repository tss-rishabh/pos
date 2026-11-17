import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import {
  csvMembershipHistorySdk,
  csvMembershipHistorySql,
  csvMembershipBigQueryOptionsSchema,
  csvMembershipWarehouse,
  type CsvMembershipBigQueryOptions,
  type CsvMembershipHistoryQueryPort,
  type CsvMembershipHistoryStatement,
} from './bigquery.js';
import {
  membershipPublicationError,
  parseCsvMembershipWarehouseFacts,
  verifyCsvMembershipSourceCapture,
  type CsvMembershipSourceCapture,
  type CsvMembershipWarehouseCapturePort,
} from './publication.js';

export const csvMembershipWarehouseCandidateContract = 'pos-csv-membership-warehouse-candidate-v1';
const candidateView = z
  .string()
  .regex(/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/);
export function csvMembershipCandidateSql(
  options: CsvMembershipBigQueryOptions,
  candidate: string,
  capture: CsvMembershipSourceCapture,
): CsvMembershipHistoryStatement {
  const parsed = candidateView.safeParse(candidate);
  if (
    !parsed.success ||
    [
      options.BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW,
      options.BQ_CSV_MEMBERSHIP_ORDERS_VIEW,
      options.BQ_CSV_MEMBERSHIP_LINES_VIEW,
    ].includes(candidate)
  )
    throw membershipPublicationError('CONFIGURATION', 503);
  const base = csvMembershipHistorySql(options, capture.scope);
  // Reuse the exact same bounded warehouse counts/selection/HP SQL as the
  // production reader. Only the unpublished candidate-control CTE differs.
  const tail = base.statement.indexOf('), delivered AS ('),
    arrayStart = base.statement.indexOf('ARRAY(SELECT AS STRUCT SUBSTR(contract'),
    arrayEnd = base.statement.indexOf('\nFROM publications) AS publications,');
  if (tail < 0 || arrayStart < tail || arrayEnd < arrayStart)
    throw membershipPublicationError('DEFINITION', 503);
  const controls = `ARRAY(SELECT AS STRUCT SUBSTR(generation_id,1,65) AS generationId,SUBSTR(customer_id,1,20) AS customerId,
FORMAT_DATETIME('%F %T',as_of) AS asOf,FORMAT_DATETIME('%F %T',cutoff) AS cutoff,
SUBSTR(source_time_zone,1,129) AS sourceTimeZone,SUBSTR(source_snapshot_id,1,37) AS sourceSnapshotId,
SUBSTR(source_capture_hash,1,65) AS sourceCaptureHash,
FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ',source_cdc_through,'UTC') AS sourceCdcThrough,
candidate_complete AS candidateComplete FROM publications) AS controls,`;
  let statement =
    base.statement.slice(0, arrayStart) +
    controls +
    base.statement.slice(arrayEnd + '\nFROM publications) AS publications,'.length);
  statement =
    `WITH publications AS (SELECT * FROM \`${parsed.data}\`
WHERE scope_shard=@scopeShard AND contract=@candidateContract AND customer_id=@customer AND as_of=@asOf AND cutoff=@cutoff
AND source_time_zone=@zone AND generation_id=@generation AND source_snapshot_id=@snapshot AND source_capture_hash=@captureHash LIMIT 2
` + statement.slice(tail);
  const { contract: _contract, ...params } = base.params,
    { contract: _type, ...types } = base.types;
  return {
    statement,
    params: {
      ...params,
      candidateContract: csvMembershipWarehouseCandidateContract,
      generation: capture.generationId,
      snapshot: capture.sourceSnapshotId,
      captureHash: capture.signature,
    },
    types: {
      ...types,
      candidateContract: 'STRING',
      generation: 'STRING',
      snapshot: 'STRING',
      captureHash: 'STRING',
    },
  };
}
/** Independently reads staged immutable facts before a COMPLETE publication
 * exists. Missing candidate/table is an error even for a native zero count. */
export function csvMembershipWarehouseCapture(
  suppliedOptions: CsvMembershipBigQueryOptions,
  candidate: string,
  authority: { sourceKey: string; memberProductIds: readonly string[] },
  dependencies: {
    query?: CsvMembershipHistoryQueryPort;
    clientFactory?: () => BigQuery;
    clock?: () => number;
  } = {},
): CsvMembershipWarehouseCapturePort {
  const parsedOptions = csvMembershipBigQueryOptionsSchema.safeParse(suppliedOptions);
  if (!parsedOptions.success || !candidateView.safeParse(candidate).success)
    throw membershipPublicationError('CONFIGURATION', 503);
  const options = parsedOptions.data,
    clock = dependencies.clock ?? Date.now,
    sourceKey = authority.sourceKey,
    members = [...authority.memberProductIds];
  let client: BigQuery | undefined;
  const factory =
    dependencies.clientFactory ??
    (() => {
      client ??= new BigQuery({
        projectId: csvMembershipWarehouse.project,
        location: csvMembershipWarehouse.location,
        autoRetry: false,
        maxRetries: 0,
      });
      client.timeout = options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS;
      return client;
    });
  return {
    async read(supplied) {
      const capture = verifyCsvMembershipSourceCapture(supplied, sourceKey, members, clock()),
        definition = csvMembershipCandidateSql(options, candidate, capture);
      const query =
        dependencies.query ??
        csvMembershipHistorySdk(options, factory, (input) => {
          if (
            input.statement !== definition.statement ||
            JSON.stringify(input.params) !== JSON.stringify(definition.params) ||
            JSON.stringify(input.types) !== JSON.stringify(definition.types)
          )
            throw membershipPublicationError('DEFINITION', 503);
          return definition;
        });
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(membershipPublicationError('WAREHOUSE_UNAVAILABLE', 503));
        }, options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS);
      });
      try {
        const raw: unknown = await Promise.race([
          deadline,
          (async () => {
            const estimate = await query.estimate(definition, abort.signal);
            if (estimate < 0n || estimate > BigInt(options.CSV_MEMBERSHIP_MAX_BYTES_BILLED))
              throw membershipPublicationError('WAREHOUSE_BUDGET', 503);
            if (abort.signal.aborted)
              throw membershipPublicationError('WAREHOUSE_UNAVAILABLE', 503);
            return query.execute(definition, abort.signal);
          })(),
        ]);
        const wire = z
          .array(z.object({ document: z.string().max(2000000) }).strict())
          .length(1)
          .safeParse(raw);
        if (!wire.success || Buffer.byteLength(wire.data[0]!.document) > 2000000)
          throw membershipPublicationError('WAREHOUSE_INCOMPLETE');
        let decoded: unknown;
        try {
          decoded = JSON.parse(wire.data[0]!.document) as unknown;
        } catch {
          throw membershipPublicationError('WAREHOUSE_INCOMPLETE');
        }
        const facts = parseCsvMembershipWarehouseFacts(
          decoded,
          options.CSV_MEMBERSHIP_MAX_ORDERS,
          options.CSV_MEMBERSHIP_MAX_LINES,
        );
        verifyCsvMembershipSourceCapture(capture, sourceKey, members, clock());
        return facts;
      } catch (error) {
        if (error instanceof AppError && error.code.startsWith('ORDER_IMPORT_MEMBERSHIP_'))
          throw error;
        throw membershipPublicationError('WAREHOUSE_UNAVAILABLE', 503);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
