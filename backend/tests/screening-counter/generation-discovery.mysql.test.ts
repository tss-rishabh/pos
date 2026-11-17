import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
const native = vi.hoisted(() => ({
  initialize:
    vi.fn<
      (typeof import('../../src/modules/legacy-order-imports/screening-counter/publisher.js'))['initializeScreeningCounter']
    >(),
}));
vi.mock('../../src/modules/legacy-order-imports/screening-counter/publisher.js', async () => ({
  ...(await vi.importActual<
    typeof import('../../src/modules/legacy-order-imports/screening-counter/publisher.js')
  >('../../src/modules/legacy-order-imports/screening-counter/publisher.js')),
  initializeScreeningCounter: native.initialize,
}));
import { counterGenerationWorker } from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-worker.js';
import { counterGenerationDiscovery } from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-discovery.js';
import {
  counterGenerationId,
  type CounterGenerationSnapshot,
  type CounterGenerationPlan,
} from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-contracts.js';
import { counterPublicationSchema } from '../../src/modules/legacy-order-imports/screening-counter/contracts.js';
import { generationSnapshot } from './generation-fixture.js';
import { quotaGenerationNativeFixture } from './generation-native-fixture.js';
const template = process.env.QUOTA_GENERATION_MYSQL_TEST_URL ?? process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('automatic discovery to durable publisher composition', () => {
  let f: Awaited<ReturnType<typeof quotaGenerationNativeFixture>>;
  beforeAll(async () => {
    f = await quotaGenerationNativeFixture(template!);
  }, 30000);
  beforeEach(async () => {
    await f.reset();
    native.initialize.mockReset();
  });
  afterAll(async () => f?.close());
  function runtime(changeHead = false) {
    const snapshots = new Map<string, CounterGenerationSnapshot>();
    let changed = false;
    const source = {
      snapshot: vi.fn(async (customerId: string) => {
        if (changeHead && !changed) {
          changed = true;
          await f.connection.execute(
            'INSERT INTO pos_rewrite_screening_counter_heads VALUES(?,1) ON DUPLICATE KEY UPDATE revision=1',
            [customerId],
          );
        }
        const [rows] = await f.connection.query<mysql.RowDataPacket[]>(
          'SELECT CAST(revision AS CHAR) revision FROM pos_rewrite_screening_counter_heads WHERE customer_id=?',
          [customerId],
        );
        const snapshot = generationSnapshot(
          customerId,
          String(rows[0]?.revision ?? '0'),
          [],
          f.clock.now,
          { serverUuid: f.options.serverUuid, sourceSchema: f.schema },
        );
        snapshots.set(customerId, snapshot);
        return {
          capture: snapshot.capture,
          rows: snapshot.rows,
          configuration: snapshot.configuration,
        };
      }),
      capture: vi.fn(async (customerId: string) => snapshots.get(customerId)!.capture),
    };
    const warehouse = {
      start: vi.fn(async (plan: CounterGenerationPlan) => ({
        status: 'succeeded' as const,
        jobId: plan.jobId,
        queryHash: plan.hash,
        evidenceHash: 'e'.repeat(64),
      })),
      recover: vi.fn(async () => {
        throw new Error('Unexpected recovery');
      }),
      verify: vi.fn(async (s: CounterGenerationSnapshot) => ({
        generationId: counterGenerationId(s),
        snapshotId: s.capture.snapshotId,
        sourceCaptureHash: s.capture.signature,
        sourceCdcThrough: s.capture.finishedAt,
        complete: true as const,
        rows: s.rows,
      })),
    };
    native.initialize.mockImplementation(async (_db, input) => {
      const p = counterPublicationSchema.parse(input.publication);
      await f.connection.execute(
        'INSERT INTO pos_rewrite_screening_counter_heads VALUES(?,?) ON DUPLICATE KEY UPDATE revision=revision',
        [p.scope.customerId, p.headRevision],
      );
      await f.connection.execute(
        'INSERT INTO pos_rewrite_screening_counters(customer_id,sku,bought,revision,baseline,baseline_hash) VALUES(?,?,?,?,?,?)',
        [p.scope.customerId, p.scope.sku, p.count, p.headRevision, JSON.stringify(p), p.signature],
      );
    });
    const enabled = { value: true },
      worker = counterGenerationWorker(f.options, {
        source,
        journal: f.journal,
        warehouse,
        projection: { ...f.db, close: async () => undefined },
        enabled: () => enabled.value,
        clock: () => f.clock.now,
      }),
      discovery = counterGenerationDiscovery(f.options, {
        source: f.source,
        demands: f.demands,
        worker,
        journal: f.journal,
        enabled: () => enabled.value,
        clock: () => f.clock.now,
      });
    return { source, warehouse, worker, discovery, enabled };
  }
  it('a newly registered user reaches a retained baseline through background discovery without per-customer CLI', async () => {
    await f.addUsers('77');
    const r = runtime();
    expect(await r.discovery.discover(new AbortController().signal)).toBe(2);
    expect(await r.discovery.prepare(new AbortController().signal)).toEqual({
      processed: 1,
      unavailable: 0,
    });
    expect(await f.source.current('77')).toMatchObject({ needed: false, available: true });
    expect(r.source.snapshot).toHaveBeenCalledTimes(1);
    expect(native.initialize).toHaveBeenCalledTimes(1);
    f.clock.now += 5000;
    await r.discovery.discover(new AbortController().signal);
    await r.discovery.prepare(new AbortController().signal);
    expect(r.source.snapshot).toHaveBeenCalledTimes(1);
  });
  it('head changes during capture roll back admission, then replace the exact demand and retry without orphan jobs', async () => {
    await f.addUsers('77');
    const r = runtime(true);
    await r.discovery.discover(new AbortController().signal);
    expect(await r.discovery.prepare(new AbortController().signal)).toEqual({
      processed: 0,
      unavailable: 1,
    });
    const [jobs] = await f.connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_screening_counter_generation_jobs',
    );
    expect(jobs).toHaveLength(0);
    f.clock.now += 5000;
    expect(await r.discovery.prepare(new AbortController().signal)).toEqual({
      processed: 1,
      unavailable: 0,
    });
    expect(await r.discovery.prepare(new AbortController().signal)).toEqual({
      processed: 1,
      unavailable: 0,
    });
    expect(await f.source.current('77')).toMatchObject({ needed: false });
    expect(r.source.snapshot).toHaveBeenCalledTimes(2);
    expect(native.initialize).toHaveBeenCalledTimes(1);
  });
  it('disabled discovery performs neither source scans nor new captures, while durable work remains recoverable', async () => {
    await f.addUsers('77');
    const r = runtime();
    r.enabled.value = false;
    expect(await r.discovery.discover(new AbortController().signal)).toBe(0);
    expect(await r.discovery.prepare(new AbortController().signal)).toEqual({
      processed: 0,
      unavailable: 0,
    });
    const [cursors] = await f.connection.query<mysql.RowDataPacket[]>(
      'SELECT lane FROM pos_rewrite_screening_counter_generation_cursors',
    );
    expect(cursors).toHaveLength(0);
    expect(r.source.snapshot).not.toHaveBeenCalled();
    expect(native.initialize).not.toHaveBeenCalled();
  });
});
