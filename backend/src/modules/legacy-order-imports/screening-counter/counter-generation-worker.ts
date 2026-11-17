import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { initializeScreeningCounter, screeningCounterSourceCapture } from './publisher.js';
import {
  counterCaptureSchema,
  counterCustomer,
  counterError,
  sealCounterPublication,
  assertCounterPublication,
} from './contracts.js';
import {
  counterGenerationPlan,
  verifyCounterGenerationPlan,
  type counterGenerationWarehouse,
} from './counter-generation-warehouse.js';
import {
  counterGenerationId,
  sealCounterGenerationSnapshot,
} from './counter-generation-contracts.js';
import type { counterGenerationJournal } from './counter-generation-journal.js';
import type { CounterGenerationOptions } from './counter-generation-options.js';
export function counterGenerationWorker(
  options: CounterGenerationOptions,
  dependencies: {
    source: ReturnType<typeof screeningCounterSourceCapture>;
    journal: ReturnType<typeof counterGenerationJournal>;
    warehouse: ReturnType<typeof counterGenerationWarehouse>;
    projection: Databases;
    enabled: () => boolean;
    clock?: () => number;
  },
) {
  const clock = dependencies.clock ?? Date.now;
  async function recovered(
    record: Awaited<ReturnType<typeof dependencies.journal.read>>,
    signal: AbortSignal,
  ) {
    if (!record.publication) return false;
    signal.throwIfAborted();
    const publication = assertCounterPublication(record.publication, options.publicationKey),
      c = record.snapshot.capture;
    const [raw] = await dependencies.projection
      .get('writer')
      .execute(
        sql`SELECT CASE WHEN OCTET_LENGTH(baseline)<=12000 THEN baseline ELSE NULL END AS baseline,baseline_hash AS hash,@@server_uuid AS serverUuid,DATABASE() AS sourceSchema FROM pos_rewrite_screening_counters WHERE customer_id=${BigInt(c.scope.customerId)} LIMIT 2`,
      );
    const rows = z
      .array(
        z.object({
          baseline: z.unknown(),
          hash: z.string(),
          serverUuid: z.string(),
          sourceSchema: z.string(),
        }),
      )
      .max(1)
      .parse(raw);
    if (!rows.length) return false;
    const row = rows[0]!;
    if (row.serverUuid !== c.serverUuid || row.sourceSchema !== c.sourceSchema)
      throw counterError('SOURCE_IDENTITY');
    const actual = assertCounterPublication(
      typeof row.baseline === 'string' ? (JSON.parse(row.baseline) as unknown) : row.baseline,
      options.publicationKey,
    );
    signal.throwIfAborted();
    return (
      actual.generationId === publication.generationId &&
      actual.signature === publication.signature &&
      row.hash === publication.signature
    );
  }
  let running: Promise<{ processed: number; unavailable: number }> | undefined;
  const service = {
    async prepare(customerId: string, expectedGeneration: string | null, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!dependencies.enabled()) throw counterError('GENERATION_DISABLED');
      counterCustomer.parse(customerId);
      const snapshot = sealCounterGenerationSnapshot(
          await dependencies.source.snapshot(customerId, signal),
          options.sourceKey,
        ),
        c = counterCaptureSchema.parse(snapshot.capture);
      if (
        c.serverUuid !== options.serverUuid ||
        c.sourceSchema !== options.sourceSchema ||
        clock() < c.finishedAt ||
        clock() - c.capturedAt > 60000
      )
        throw counterError('SOURCE_IDENTITY');
      signal.throwIfAborted();
      if (!dependencies.enabled()) throw counterError('GENERATION_DISABLED');
      return dependencies.journal.create(
        snapshot,
        counterGenerationPlan(snapshot, options),
        expectedGeneration,
      );
    },
    async advance(id: string, signal: AbortSignal) {
      const record = await dependencies.journal.read(id);
      if (['seeded', 'failed'].includes(record.phase)) return record;
      verifyCounterGenerationPlan(record.plan, record.snapshot, options);
      if (record.id !== counterGenerationId(record.snapshot))
        throw counterError('GENERATION_JOURNAL');
      if (record.phase === 'materializing')
        return dependencies.journal.acknowledge(
          id,
          await dependencies.warehouse.recover(record.plan, signal),
        );
      if (record.phase === 'seeding') {
        if (await recovered(record, signal)) return dependencies.journal.finish(id, true);
        return dependencies.journal.polled(id);
      }
      if (!dependencies.enabled() || signal.aborted) return record;
      if (clock() - record.snapshot.capture.capturedAt > 60000)
        return dependencies.journal.finish(id, false);
      if (record.phase === 'prepared') {
        const claim = await dependencies.journal.claim(id, 'prepared');
        if (!claim.send) return claim.record;
        if (signal.aborted || !dependencies.enabled()) return claim.record;
        return dependencies.journal.acknowledge(
          id,
          await dependencies.warehouse.start(claim.record.plan, signal),
        );
      }
      if (record.phase === 'materialized') {
        const evidence = await dependencies.warehouse.verify(record.snapshot, signal);
        if (evidence.generationId !== id) throw counterError('GENERATION_MISMATCH');
        const sealed = sealCounterPublication(
          record.snapshot.capture,
          options.sourceKey,
          options.publicationKey,
          evidence,
          clock(),
        );
        signal.throwIfAborted();
        if (!dependencies.enabled()) return record;
        return dependencies.journal.verified(id, sealed.publication);
      }
      if (record.phase === 'verified') {
        if (!record.publication) throw counterError('GENERATION_JOURNAL');
        const publication = assertCounterPublication(record.publication, options.publicationKey),
          claim = await dependencies.journal.claim(id, 'verified');
        if (!claim.send) return claim.record;
        signal.throwIfAborted();
        if (!dependencies.enabled()) return claim.record;
        await initializeScreeningCounter(
          dependencies.projection,
          { publication, rows: record.snapshot.rows },
          options.publicationKey,
          record.expectedGeneration,
          clock(),
          {
            headMetadata: options.headMetadata,
            configuration: record.snapshot.configuration,
            purpose: 'counter-publication',
            clock,
          },
        );
        // The native commit is factual even if the abort fires after commit. Keep
        // its acknowledgement when available; the seeding recovery reads it only.
        return dependencies.journal.finish(id, true);
      }
      return record;
    },
    drain(signal: AbortSignal, limit = 2) {
      if (running) return running;
      running = (async () => {
        const summary = { processed: 0, unavailable: 0 };
        for (const id of await dependencies.journal.due(limit)) {
          if (signal.aborted) break;
          try {
            await service.advance(id, signal);
            summary.processed++;
          } catch {
            summary.unavailable++;
          }
        }
        return summary;
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
  return service;
}
