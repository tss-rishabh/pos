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
  assertCounterDefinitions,
  counterDefinitionHash,
  assertCounterIndexes,
  counterIndexSql,
} from './writers.js';
import { assertCounterRuntimePrivileges } from './privileges.js';

export interface ScreeningCounterOptions {
  contract?: typeof counterContract;
  publicationKey?: string;
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
  };
}
const qualified = new WeakMap<AdministrationTransaction, { hash: string; owner: string }>();
export async function qualifyCounterWriterDefinitions(tx: AdministrationTransaction) {
  const prior = qualified.get(tx);
  if (prior) return prior;
  // No source rows: hold metadata locks until this transaction ends.
  await tx.execute(
    sql.raw(
      'SELECT 1 FROM orders o,has_products hp,spiderman_screening_orders s,pos_rewrite_screening_counter_heads h,pos_rewrite_screening_counters c,pos_rewrite_screening_contributions x WHERE FALSE',
    ),
  );
  const [indexes] = await tx.execute(sql.raw(counterIndexSql));
  assertCounterIndexes(indexes);
  const [triggers] = await tx.execute(
    sql.raw(
      "SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS `table`,EVENT_MANIPULATION AS event,ACTION_TIMING AS timing,ACTION_STATEMENT AS statement,DEFINER AS owner FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME LIKE 'pos_screening_%' ORDER BY TRIGGER_NAME",
    ),
  );
  const [procedures] = await tx.execute(
    sql.raw(
      "SELECT ROUTINE_NAME AS name,ROUTINE_TYPE AS type,SECURITY_TYPE AS security,ROUTINE_DEFINITION AS statement,DEFINER AS owner FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME='pos_screening_sync_marker'",
    ),
  );
  const hash = assertCounterDefinitions(triggers, procedures);
  qualified.set(tx, hash);
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
  const definition = await qualifyCounterWriterDefinitions(tx);
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
    CAST(COUNT(*) AS CHAR) AS rows FROM (SELECT included FROM pos_rewrite_screening_contributions WHERE customer_id=${BigInt(customerId)} LIMIT 10001) current_rows`);
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
