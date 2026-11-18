import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { assertScreeningCustomer } from '../screening-transactions.js';
import {
  counterContract,
  counterCustomer,
  counterCount,
  counterSku,
  counterError,
  assertCounterPublication,
  type CounterPublication,
} from './contracts.js';
import {
  counterTriggers,
  counterProcedure,
  counterDefinitionHash,
  assertCounterIndexes,
  counterIndexSql,
} from './writers.js';
import { assertCounterRuntimePrivileges } from './privileges.js';
import {
  readNativeHeadMetadata,
  readNativeHeadMetadataOptions,
  canonicalNativeHeadJson,
  type NativeHeadMetadataOptions,
} from '../../screening-origins/native-head-metadata.js';

export interface ScreeningCounterOptions {
  contract?: typeof counterContract;
  publicationKey?: string;
  headMetadata?: NativeHeadMetadataOptions;
}
export function readScreeningCounterOptions(
  env: NodeJS.ProcessEnv = process.env,
): ScreeningCounterOptions {
  const contract = env.POS_SCREENING_COUNTER_CONTRACT;
  const publicationKey = env.POS_SCREENING_COUNTER_PUBLICATION_KEY;
  if (contract !== undefined && contract !== '' && contract !== counterContract)
    throw counterError('CONFIGURATION');
  return {
    ...(contract === counterContract ? { contract } : {}),
    ...(publicationKey ? { publicationKey } : {}),
    ...(contract === counterContract ? { headMetadata: readNativeHeadMetadataOptions(env) } : {}),
  };
}
export interface CounterDefinitionQualification {
  hash: string;
  owner: string;
  configuration: string;
}
export async function qualifyCounterWriterDefinitions(
  tx: AdministrationTransaction,
  options: NativeHeadMetadataOptions = readNativeHeadMetadataOptions(),
): Promise<CounterDefinitionQualification> {
  return qualifyCounterDefinitions(tx, options, 'application');
}
/** Only the configured projection publisher may enter this dedicated path.
 * The source reader's authenticated configuration is compared inside its CAS
 * transaction; generic/application qualification retains its stricter caller. */
export async function qualifyCounterPublisherDefinitions(
  tx: AdministrationTransaction,
  options: NativeHeadMetadataOptions,
  expectedConfiguration: string,
): Promise<CounterDefinitionQualification> {
  if (
    typeof expectedConfiguration !== 'string' ||
    expectedConfiguration.length < 1 ||
    Buffer.byteLength(expectedConfiguration) > 20000
  )
    throw counterError('WRITERS_UNQUALIFIED');
  const value = await qualifyCounterDefinitions(tx, options, 'counter-publication');
  if (value.configuration !== expectedConfiguration) throw counterError('WRITERS_UNQUALIFIED');
  return value;
}
async function qualifyCounterDefinitions(
  tx: AdministrationTransaction,
  options: NativeHeadMetadataOptions,
  purpose: 'application' | 'counter-publication',
): Promise<CounterDefinitionQualification> {
  // No source rows: hold metadata locks until this transaction ends.
  await tx.execute(
    sql.raw(
      'SELECT 1 FROM orders o,has_products hp,spiderman_screening_orders s,pos_rewrite_screening_counter_heads h,pos_rewrite_screening_counters c,pos_rewrite_screening_contributions x WHERE FALSE',
    ),
  );
  const [indexes] = await tx.execute(sql.raw(counterIndexSql));
  assertCounterIndexes(indexes);
  const metadata = await readNativeHeadMetadata(tx, options, { purpose });
  const configuration = canonicalNativeHeadJson({ options, policy: metadata.policy });
  const normalizedHash = (body: string) =>
    createHash('sha256').update(body.trim().split(/\s+/).join(' ')).digest('hex');
  if (metadata.counterTriggers.length !== 9 || metadata.counterProcedures.length !== 1)
    throw counterError('WRITERS_UNQUALIFIED');
  for (const expected of counterTriggers) {
    const actual = metadata.counterTriggers.filter((value) => value.name === expected.name);
    if (
      actual.length !== 1 ||
      actual[0]!.tableName !== expected.table ||
      actual[0]!.event !== expected.event ||
      actual[0]!.timing !== expected.timing ||
      actual[0]!.hash !== normalizedHash(expected.statement)
    )
      throw counterError('WRITERS_UNQUALIFIED');
  }
  const procedure = metadata.counterProcedures[0]!;
  if (
    procedure.name !== counterProcedure.name ||
    procedure.kind !== counterProcedure.type ||
    procedure.security !== counterProcedure.security ||
    procedure.hash !== normalizedHash(counterProcedure.statement) ||
    procedure.definer !== options.counterDefiner ||
    metadata.counterTriggers.some((value) => value.definer !== procedure.definer)
  )
    throw counterError('WRITERS_UNQUALIFIED');
  const hash = { hash: counterDefinitionHash, owner: procedure.definer, configuration };
  return hash;
}
function parsedJson(value: unknown): unknown {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  } catch {
    throw counterError('PROJECTION_INVALID');
  }
}
export interface CurrentScreeningCounter {
  count: bigint;
  revision: string;
  baseline: CounterPublication;
}
/** Current operational state only. Missing baseline/coverage is not zero. */
export async function readCurrentScreeningCounter(
  tx: AdministrationTransaction,
  customer: string,
  options: ScreeningCounterOptions = readScreeningCounterOptions(),
): Promise<CurrentScreeningCounter> {
  const customerId = counterCustomer.parse(customer);
  assertScreeningCustomer(tx, customerId);
  if (options.contract !== counterContract || !options.publicationKey)
    throw counterError('QUALIFICATION_REQUIRED');
  const definition = await qualifyCounterWriterDefinitions(
    tx,
    options.headMetadata ?? readNativeHeadMetadataOptions(),
  );
  const [raw] =
    await tx.execute(sql`SELECT CAST(c.customer_id AS CHAR) AS customerId,CAST(c.sku AS CHAR) AS sku,
    @@server_uuid AS serverUuid,DATABASE() AS sourceSchema,
    CAST(c.bought AS CHAR) AS count,CAST(c.revision AS CHAR) AS revision,
    CAST(h.revision AS CHAR) AS headRevision,
    CASE WHEN OCTET_LENGTH(c.baseline)<=12000 THEN c.baseline ELSE NULL END AS baseline,c.baseline_hash AS baselineHash
    FROM pos_rewrite_screening_counters c JOIN pos_rewrite_screening_counter_heads h ON h.customer_id=c.customer_id
    WHERE c.customer_id=${BigInt(customerId)} FOR SHARE`);
  const result = z
    .array(
      z
        .object({
          customerId: counterCustomer,
          sku: z.literal(counterSku),
          serverUuid: z.uuid(),
          sourceSchema: z.string(),
          count: counterCount,
          revision: counterCount,
          headRevision: counterCount,
          baseline: z.unknown(),
          baselineHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    )
    .length(1)
    .safeParse(raw);
  if (!result.success) throw counterError('PROJECTION_REQUIRED');
  const row = result.data[0]!,
    baseline = assertCounterPublication(parsedJson(row.baseline), options.publicationKey);
  if (
    row.customerId !== customerId ||
    row.revision !== row.headRevision ||
    BigInt(row.revision) < BigInt(baseline.headRevision) ||
    baseline.scope.customerId !== customerId ||
    baseline.scope.sku !== counterSku ||
    baseline.writersDefinitionHash !== counterDefinitionHash ||
    baseline.writersOwner !== definition.owner ||
    baseline.serverUuid !== row.serverUuid ||
    baseline.sourceSchema !== row.sourceSchema ||
    row.baselineHash !== baseline.signature
  )
    throw counterError('PROJECTION_INVALID');
  await assertCounterRuntimePrivileges(tx, baseline.writersOwner);
  const [rawTotal] = await tx.execute(sql`SELECT CAST(COALESCE(SUM(included),0) AS CHAR) AS count,
    CAST(COUNT(*) AS CHAR) AS \`rows\` FROM (SELECT included FROM pos_rewrite_screening_contributions WHERE customer_id=${BigInt(customerId)} LIMIT 10001) current_rows`);
  const totals = z
    .array(z.object({ count: counterCount, rows: counterCount }))
    .length(1)
    .safeParse(rawTotal);
  if (
    !totals.success ||
    totals.data[0]!.count !== row.count ||
    BigInt(totals.data[0]!.rows) > 10000n
  )
    throw counterError('PROJECTION_INVALID');
  return { count: BigInt(row.count), revision: row.revision, baseline };
}
