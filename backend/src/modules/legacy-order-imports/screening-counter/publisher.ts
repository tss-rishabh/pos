import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { financialTransaction, lockScreeningCustomer } from '../screening-transactions.js';
import { qualifyCounterWriterDefinitions } from './reader.js';
import { counterDefinitionHash } from './writers.js';
import {
  counterCustomer,
  counterSku,
  counterSourceContract,
  counterSourceCommit,
  counterCount,
  counterError,
  counterDigest,
  counterRows,
  counterRowsHash,
  assertCounterPublication,
  sealCounterPublication,
  type CounterCapture,
  type CounterRow,
} from './contracts.js';

/** Independent read-only publisher qualification only. Never call from a
 * checkout/preview/admission request, nor as a historical MySQL fallback. */
export function screeningCounterSourceCapture(
  db: Pick<Databases, 'get'>,
  key: string,
  clock = Date.now,
) {
  counterDigest(key, 'capture', null);
  return {
    async capture(customer: string): Promise<CounterCapture> {
      const customerId = counterCustomer.parse(customer);
      return db.get('writer').transaction(
        async (tx) => {
          const capturedAt = clock();
          const writers = await qualifyCounterWriterDefinitions(tx);
          const [identityRaw] = await tx.execute(
            sql`SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema`,
          );
          const identity = z
            .array(
              z.object({
                serverUuid: z.uuid(),
                sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
              }),
            )
            .length(1)
            .parse(identityRaw)[0]!;
          const [headRaw] = await tx.execute(
            sql`SELECT CAST(revision AS CHAR) AS revision FROM pos_rewrite_screening_counter_heads WHERE customer_id=${BigInt(customerId)}`,
          );
          const heads = z
            .array(z.object({ revision: counterCount }))
            .max(1)
            .parse(headRaw);
          const [raw] =
            await tx.execute(sql`SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(s.id AS CHAR) AS markerId,
          CAST(s.order_id AS CHAR) AS orderId,CAST(s.has_product_id AS CHAR) AS lineId,
          IF(hp.prod_id=${BigInt(counterSku)} AND o.order_status NOT IN(0,17),1,0) AS included
          FROM spiderman_screening_orders s FORCE INDEX(idx_user_id)
          LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN has_products hp ON hp.id=s.has_product_id
          WHERE s.user_id=${BigInt(customerId)} ORDER BY s.id LIMIT 10001`);
          const records = z
            .array(
              z.object({
                markerId: z.string(),
                orderId: z.string(),
                lineId: z.string(),
                included: z.union([z.literal(0), z.literal(1)]),
              }),
            )
            .max(10000)
            .safeParse(raw);
          if (!records.success) throw counterError('SOURCE_TOO_LARGE');
          const rows = counterRows(
            records.data.map((row) => ({ ...row, included: row.included === 1 })),
          );
          const body: Omit<CounterCapture, 'signature'> = {
            contract: counterSourceContract,
            sourceCommit: counterSourceCommit,
            scope: { customerId, sku: counterSku },
            snapshotId: randomUUID(),
            ...identity,
            headRevision: heads[0]?.revision ?? '0',
            writersDefinitionHash: counterDefinitionHash,
            writersOwner: writers.owner,
            rows: String(rows.length),
            count: String(rows.filter((row) => row.included).length),
            rowsHash: counterRowsHash(rows),
            capturedAt,
            finishedAt: clock(),
          };
          return { ...body, signature: counterDigest(key, 'capture', body) };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    },
  };
}
export interface ScreeningCounterWarehouse {
  read(
    capture: CounterCapture,
    signal?: AbortSignal,
  ): Promise<{
    generationId: string;
    snapshotId: string;
    sourceCaptureHash: string;
    sourceCdcThrough: number;
    complete: true;
    rows: CounterRow[];
  }>;
}
export function screeningCounterPublisher(
  db: Databases,
  options: { sourceKey: string; publicationKey: string },
  warehouse: ScreeningCounterWarehouse,
  clock = Date.now,
) {
  const source = screeningCounterSourceCapture(db, options.sourceKey, clock);
  async function complete(
    capture: CounterCapture,
    expectedGeneration: string | null = null,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const evidence = await warehouse.read(capture, signal);
    const baseline = sealCounterPublication(
      capture,
      options.sourceKey,
      options.publicationKey,
      evidence,
      clock(),
    );
    signal?.throwIfAborted();
    await initializeScreeningCounter(
      db,
      baseline,
      options.publicationKey,
      expectedGeneration,
      clock(),
    );
    return baseline.publication;
  }
  return {
    // Two phases are deliberate: the independent publisher receives this
    // signed metadata and publishes the exact BQ generation before complete.
    // No random snapshot is assumed to exist before it has been published.
    capture: source.capture,
    complete,
    async publish(
      customerId: string,
      expectedGeneration: string | null = null,
      signal?: AbortSignal,
    ) {
      const capture = await source.capture(customerId);
      // Independent BQ result/publication; no native facts are supplied to the
      // warehouse port and no SQL transaction survives the HTTP query.
      return complete(capture, expectedGeneration, signal);
    },
  };
}
/** Server publisher only. A signed empty publication is required for 0 too. */
export async function initializeScreeningCounter(
  db: Databases,
  input: { publication: unknown; rows: unknown },
  key: string,
  expectedGeneration: string | null = null,
  now = Date.now(),
): Promise<void> {
  const publication = assertCounterPublication(input.publication, key),
    rows = counterRows(input.rows);
  if (
    now < publication.publishedAt ||
    now - publication.sourceCapturedAt > 60000 ||
    publication.writersDefinitionHash !== counterDefinitionHash ||
    publication.rows !== String(rows.length) ||
    publication.count !== String(rows.filter((row) => row.included).length) ||
    publication.rowsHash !== counterRowsHash(rows)
  )
    throw counterError('BASELINE_INVALID');
  await financialTransaction(db, true, async (tx) => {
    await lockScreeningCustomer(tx, publication.scope.customerId);
    const writers = await qualifyCounterWriterDefinitions(tx);
    if (writers.owner !== publication.writersOwner) throw counterError('WRITERS_UNQUALIFIED');
    const [rawIdentity] = await tx.execute(
      sql`SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema`,
    );
    const identity = z
      .array(z.object({ serverUuid: z.uuid(), sourceSchema: z.string() }))
      .length(1)
      .parse(rawIdentity)[0]!;
    if (
      identity.serverUuid !== publication.serverUuid ||
      identity.sourceSchema !== publication.sourceSchema
    )
      throw counterError('SOURCE_IDENTITY');
    await tx.execute(
      sql`INSERT INTO pos_rewrite_screening_counter_heads(customer_id,revision) VALUES(${BigInt(publication.scope.customerId)},0) ON DUPLICATE KEY UPDATE customer_id=customer_id`,
    );
    const [rawHead] = await tx.execute(
      sql`SELECT CAST(revision AS CHAR) AS revision FROM pos_rewrite_screening_counter_heads WHERE customer_id=${BigInt(publication.scope.customerId)} FOR UPDATE`,
    );
    const head = z
      .array(z.object({ revision: counterCount }))
      .length(1)
      .parse(rawHead)[0]!;
    if (head.revision !== publication.headRevision) throw counterError('SOURCE_CHANGED');
    const [rawPrior] = await tx.execute(
      sql`SELECT baseline FROM pos_rewrite_screening_counters WHERE customer_id=${BigInt(publication.scope.customerId)} FOR UPDATE`,
    );
    const priors = z
      .array(z.object({ baseline: z.unknown() }))
      .max(1)
      .parse(rawPrior);
    if (priors.length) {
      const raw = priors[0]!.baseline;
      const previous = assertCounterPublication(
        typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw,
        key,
      );
      if (previous.generationId === publication.generationId) {
        if (previous.signature !== publication.signature) throw counterError('BASELINE_CHANGED');
        return;
      }
      if (expectedGeneration !== previous.generationId) throw counterError('BASELINE_CHANGED');
    } else if (expectedGeneration !== null) throw counterError('BASELINE_CHANGED');
    await tx.execute(
      sql`DELETE FROM pos_rewrite_screening_contributions WHERE customer_id=${BigInt(publication.scope.customerId)}`,
    );
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows
        .slice(offset, offset + 500)
        .map(
          (row) =>
            sql`(${BigInt(row.markerId)},${BigInt(publication.scope.customerId)},${BigInt(row.orderId)},${BigInt(row.lineId)},${row.included ? 1 : 0})`,
        );
      await tx.execute(
        sql`INSERT INTO pos_rewrite_screening_contributions(marker_id,customer_id,order_id,line_id,included) VALUES ${sql.join(batch, sql`,`)}`,
      );
    }
    await tx.execute(sql`INSERT INTO pos_rewrite_screening_counters(customer_id,sku,bought,revision,baseline,baseline_hash)
      VALUES(${BigInt(publication.scope.customerId)},${BigInt(counterSku)},${BigInt(publication.count)},${BigInt(publication.headRevision)},${JSON.stringify(publication)},${publication.signature})
      ON DUPLICATE KEY UPDATE bought=VALUES(bought),revision=VALUES(revision),baseline=VALUES(baseline),baseline_hash=VALUES(baseline_hash)`);
  });
}
