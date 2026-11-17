import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import {
  assertCounterPublication,
  counterCount,
  counterCustomer,
  counterError,
  counterSku,
} from './contracts.js';
import { counterDefinitionHash } from './writers.js';
import type { CounterGenerationOptions } from './counter-generation-options.js';
import type {
  counterGenerationDemands,
  CounterGenerationCursor,
  CounterGenerationDemandRequest,
} from './counter-generation-demands.js';
import type { counterGenerationWorker } from './counter-generation-worker.js';
import type { counterGenerationJournal } from './counter-generation-journal.js';
const rowSchema = z.object({
  customerId: counterCustomer,
  headRevision: counterCount,
  projectionRevision: counterCount.nullable(),
  bought: counterCount.nullable(),
  baselineHash: z.string().nullable(),
  baseline: z.unknown(),
  hasProjection: z.enum(['0', '1']),
});
interface Candidate {
  request: CounterGenerationDemandRequest;
  needed: boolean;
  available: boolean;
}
/** Current users/operational controls only. This lane does not read any marker,
 * Order or HP history; only the separately claimed background capture may. */
export function counterGenerationDiscoverySource(
  db: Pick<Databases, 'get'>,
  options: CounterGenerationOptions,
) {
  async function query(after: string | null, latest: boolean, customerId?: string) {
    return db.get('writer').transaction(
      async (tx) => {
        const [identityRaw] = await tx.execute(
          sql`SELECT @@server_uuid AS serverUuid,DATABASE() AS sourceSchema`,
        );
        const identity = z
          .array(z.object({ serverUuid: z.uuid(), sourceSchema: z.string() }))
          .length(1)
          .parse(identityRaw)[0]!;
        if (
          identity.serverUuid !== options.serverUuid ||
          identity.sourceSchema !== options.sourceSchema
        )
          throw counterError('SOURCE_IDENTITY');
        const filter = customerId
          ? sql`u.id=${BigInt(customerId)}`
          : latest
            ? sql`TRUE`
            : sql`u.id>${BigInt(after ?? '0')}`;
        const [raw] =
          await tx.execute(sql`SELECT CAST(u.id AS CHAR) AS customerId,CAST(COALESCE(h.revision,0) AS CHAR) AS headRevision,
    CAST(c.revision AS CHAR) AS projectionRevision,CAST(c.bought AS CHAR) AS bought,c.baseline_hash AS baselineHash,
    CASE WHEN OCTET_LENGTH(c.baseline)<=12000 THEN c.baseline ELSE NULL END AS baseline,
    CAST(CASE WHEN c.customer_id IS NULL THEN 0 ELSE 1 END AS CHAR) AS hasProjection
    FROM users u LEFT JOIN pos_rewrite_screening_counter_heads h ON h.customer_id=u.id
    LEFT JOIN pos_rewrite_screening_counters c ON c.customer_id=u.id
    WHERE ${filter} AND u.id>0 ORDER BY u.id ${latest ? sql`DESC` : sql`ASC`} LIMIT ${customerId ? 1 : options.discoveryBatchSize}`);
        const records = z.array(rowSchema).max(options.discoveryBatchSize).parse(raw);
        return records.map((row) => {
          const request: CounterGenerationDemandRequest = {
            customerId: row.customerId,
            headRevision: row.headRevision,
            expectedGeneration: null,
          };
          if (row.hasProjection === '0') return { request, needed: true, available: true };
          try {
            const input = Buffer.isBuffer(row.baseline)
              ? (JSON.parse(row.baseline.toString('utf8')) as unknown)
              : typeof row.baseline === 'string'
                ? (JSON.parse(row.baseline) as unknown)
                : row.baseline;
            const baseline = assertCounterPublication(input, options.publicationKey);
            request.expectedGeneration = baseline.generationId;
            if (
              baseline.scope.customerId !== row.customerId ||
              baseline.scope.sku !== counterSku ||
              baseline.serverUuid !== identity.serverUuid ||
              baseline.sourceSchema !== identity.sourceSchema ||
              baseline.writersOwner !== options.headMetadata.counterDefiner ||
              baseline.writersDefinitionHash !== counterDefinitionHash ||
              row.baselineHash !== baseline.signature
            )
              return { request, needed: true, available: false };
            const healthy =
              row.projectionRevision === row.headRevision &&
              row.projectionRevision !== null &&
              BigInt(row.projectionRevision) >= BigInt(baseline.headRevision) &&
              row.bought !== null;
            return { request, needed: !healthy, available: true };
          } catch {
            return { request, needed: true, available: false };
          }
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  return {
    async page(cursor: CounterGenerationCursor) {
      const latest = cursor.lane === 'new' && !cursor.initialized,
        rows = await query(cursor.after, latest);
      const ids = rows.map((row) => BigInt(row.request.customerId));
      const after = ids.length
        ? String(ids.reduce((a, b) => (a > b ? a : b)))
        : cursor.lane === 'backfill'
          ? '0'
          : cursor.after;
      return { requests: rows.filter((row) => row.needed).map((row) => row.request), after };
    },
    async current(customerId: string): Promise<Candidate | null> {
      counterCustomer.parse(customerId);
      return (await query(null, false, customerId))[0] ?? null;
    },
  };
}
export function counterGenerationDiscovery(
  options: CounterGenerationOptions,
  dependencies: {
    source: ReturnType<typeof counterGenerationDiscoverySource>;
    demands: ReturnType<typeof counterGenerationDemands>;
    worker: ReturnType<typeof counterGenerationWorker>;
    journal: ReturnType<typeof counterGenerationJournal>;
    enabled: () => boolean;
    clock?: () => number;
  },
) {
  const clock = dependencies.clock ?? Date.now;
  async function progress(id: string, signal: AbortSignal) {
    let job = await dependencies.journal.read(id);
    // Finite pipeline work lets a fresh user's job progress immediately rather
    // than waiting behind every historical customer's generic journal entry.
    for (let step = 0; step < 6 && !signal.aborted; step++) {
      if (['seeded', 'failed'].includes(job.phase)) break;
      const before = job.phase;
      job = await dependencies.worker.advance(id, signal);
      if (job.phase === before) break;
    }
    return job;
  }
  return {
    async discover(signal: AbortSignal) {
      let admitted = 0;
      if (!dependencies.enabled()) return admitted;
      for (const lane of ['new', 'backfill'] as const) {
        signal.throwIfAborted();
        if (!dependencies.enabled()) break;
        const cursor = await dependencies.demands.cursor(lane);
        if (cursor.dueAt > clock()) continue;
        const page = await dependencies.source.page(cursor);
        signal.throwIfAborted();
        if (!dependencies.enabled()) break;
        if (
          await dependencies.demands.admitPage(
            cursor,
            page.requests,
            page.after,
            options.discoveryIntervalMs,
          )
        )
          admitted += page.requests.length;
      }
      return admitted;
    },
    async prepare(signal: AbortSignal) {
      const summary = { processed: 0, unavailable: 0 };
      if (!dependencies.enabled()) return summary;
      for (const id of await dependencies.demands.due(options.maxDiscovery)) {
        if (signal.aborted || !dependencies.enabled()) break;
        let lease: string | undefined;
        try {
          const before = await dependencies.demands.read(id);
          if (before.phase === 'prepared') {
            if (!before.generationId) throw counterError('GENERATION_DEMAND_INVALID');
            const job = await progress(before.generationId, signal);
            if (job.phase === 'seeded') await dependencies.demands.satisfied(id);
            else await dependencies.demands.poll(id, job.phase === 'failed');
            summary.processed++;
            continue;
          }
          const claim = await dependencies.demands.claim(id);
          if (!claim?.lease) continue;
          lease = claim.lease;
          const candidate = await dependencies.source.current(claim.request.customerId);
          signal.throwIfAborted();
          if (!candidate || !candidate.needed) {
            await dependencies.demands.satisfied(id, lease);
            summary.processed++;
            continue;
          }
          if (!candidate.available) throw counterError('GENERATION_PROJECTION_REVIEW_REQUIRED');
          if (JSON.stringify(candidate.request) !== JSON.stringify(claim.request)) {
            await dependencies.demands.replace(id, lease, candidate.request);
            summary.processed++;
            continue;
          }
          if (!dependencies.enabled()) throw counterError('GENERATION_DISABLED');
          const job = await dependencies.worker.prepare(
            claim.request.customerId,
            claim.request.expectedGeneration,
            signal,
            (tx, record) => dependencies.demands.bind(tx, id, lease!, record),
          );
          lease = undefined;
          const advanced = await progress(job.id, signal);
          if (advanced.phase === 'seeded') await dependencies.demands.satisfied(id);
          else await dependencies.demands.poll(id, advanced.phase === 'failed');
          summary.processed++;
        } catch {
          summary.unavailable++;
          if (lease) await dependencies.demands.retry(id, lease);
          else await dependencies.demands.poll(id);
        }
      }
      return summary;
    },
  };
}
