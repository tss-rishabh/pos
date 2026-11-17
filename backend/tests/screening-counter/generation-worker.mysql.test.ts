import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  counterGenerationId,
  type CounterGenerationPlan,
  type CounterGenerationReply,
} from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-contracts.js';
import { counterPublicationSchema } from '../../src/modules/legacy-order-imports/screening-counter/contracts.js';
import { generationSnapshot } from './generation-fixture.js';
import { quotaGenerationNativeFixture } from './generation-native-fixture.js';
const template = process.env.QUOTA_GENERATION_MYSQL_TEST_URL ?? process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('quota worker durable dispatch and recovery protocol', () => {
  let f: Awaited<ReturnType<typeof quotaGenerationNativeFixture>>;
  beforeAll(async () => {
    f = await quotaGenerationNativeFixture(template!);
  }, 30000);
  beforeEach(async () => {
    await f.reset();
    native.initialize.mockReset();
    native.initialize.mockResolvedValue(undefined);
  });
  afterAll(async () => f?.close());
  function runtime() {
    const snapshot = generationSnapshot('77', '3', undefined, f.clock.now, {
      serverUuid: f.options.serverUuid,
      sourceSchema: f.schema,
    });
    const source = {
      snapshot: vi.fn(async () => ({
        capture: snapshot.capture,
        rows: snapshot.rows,
        configuration: snapshot.configuration,
      })),
      capture: vi.fn(async () => snapshot.capture),
    };
    const response = (
      plan: CounterGenerationPlan,
      status: CounterGenerationReply['status'] = 'succeeded',
    ) => ({ status, jobId: plan.jobId, queryHash: plan.hash, evidenceHash: 'e'.repeat(64) });
    const warehouse = {
      start: vi.fn(async (plan: CounterGenerationPlan) => response(plan)),
      recover: vi.fn(async (plan: CounterGenerationPlan) => response(plan)),
      verify: vi.fn(async () => ({
        generationId: counterGenerationId(snapshot),
        snapshotId: snapshot.capture.snapshotId,
        sourceCaptureHash: snapshot.capture.signature,
        sourceCdcThrough: snapshot.capture.finishedAt,
        complete: true as const,
        rows: snapshot.rows,
      })),
    };
    const enabled = { value: true },
      worker = counterGenerationWorker(f.options, {
        source,
        journal: f.journal,
        warehouse,
        projection: { ...f.db, close: async () => undefined },
        enabled: () => enabled.value,
        clock: () => f.clock.now,
      });
    return { snapshot, source, warehouse, worker, enabled, response };
  }
  it('retains exact snapshot/configuration through materialization, verification and one native seed', async () => {
    const r = runtime(),
      prepared = await r.worker.prepare('77', null, new AbortController().signal);
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'materialized',
    );
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'verified',
    );
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'seeded',
    );
    expect(native.initialize).toHaveBeenCalledTimes(1);
    expect(native.initialize.mock.calls[0]![5]).toMatchObject({
      purpose: 'counter-publication',
      configuration: r.snapshot.configuration,
      headMetadata: f.options.headMetadata,
    });
    await r.worker.advance(prepared.id, new AbortController().signal);
    expect(native.initialize).toHaveBeenCalledTimes(1);
    expect(r.source.snapshot).toHaveBeenCalledTimes(1);
  });
  it('recovers an unknown original warehouse job while disabled without dispatch, recapture or native seed', async () => {
    const r = runtime();
    r.warehouse.start.mockImplementation(async (plan) => r.response(plan, 'unknown'));
    const prepared = await r.worker.prepare('77', null, new AbortController().signal);
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'materializing',
    );
    r.enabled.value = false;
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'materialized',
    );
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'materialized',
    );
    expect(r.warehouse.start).toHaveBeenCalledTimes(1);
    expect(r.warehouse.recover).toHaveBeenCalledTimes(1);
    expect(r.warehouse.verify).not.toHaveBeenCalled();
    expect(native.initialize).not.toHaveBeenCalled();
    expect(r.source.snapshot).toHaveBeenCalledTimes(1);
  });
  it('fails expired undispatched captures and never substitutes a fresh source capture', async () => {
    const r = runtime(),
      prepared = await r.worker.prepare('77', null, new AbortController().signal);
    f.clock.now += 60001;
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'failed',
    );
    expect(r.warehouse.start).not.toHaveBeenCalled();
    expect(native.initialize).not.toHaveBeenCalled();
    await expect(r.worker.prepare('77', null, new AbortController().signal)).rejects.toMatchObject({
      code: 'SCREENING_COUNTER_SOURCE_IDENTITY',
    });
  });
  it('records a late original job success but refuses an expired source baseline', async () => {
    const r = runtime();
    r.warehouse.start.mockImplementation(async (plan) => r.response(plan, 'unknown'));
    const prepared = await r.worker.prepare('77', null, new AbortController().signal);
    await r.worker.advance(prepared.id, new AbortController().signal);
    f.clock.now += 60001;
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'materialized',
    );
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'failed',
    );
    expect(native.initialize).not.toHaveBeenCalled();
  });
  it('recovers an actual stored seed after a lost acknowledgement beyond capture expiry without reseeding', async () => {
    const r = runtime(),
      prepared = await r.worker.prepare('77', null, new AbortController().signal);
    await r.worker.advance(prepared.id, new AbortController().signal);
    await r.worker.advance(prepared.id, new AbortController().signal);
    native.initialize.mockImplementation(async (_db, input) => {
      const p = counterPublicationSchema.parse(input.publication);
      await f.connection.execute(
        'INSERT INTO pos_rewrite_screening_counters(customer_id,sku,bought,revision,baseline,baseline_hash) VALUES(?,?,?,?,?,?)',
        [p.scope.customerId, p.scope.sku, p.count, p.headRevision, JSON.stringify(p), p.signature],
      );
      throw new Error('synthetic lost native commit ack');
    });
    await expect(r.worker.advance(prepared.id, new AbortController().signal)).rejects.toThrow(
      'synthetic lost native',
    );
    expect((await f.journal.read(prepared.id)).phase).toBe('seeding');
    f.clock.now += 120000;
    r.enabled.value = false;
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'seeded',
    );
    expect(native.initialize).toHaveBeenCalledTimes(1);
    expect(r.warehouse.start).toHaveBeenCalledTimes(1);
    expect(r.source.snapshot).toHaveBeenCalledTimes(1);
  });
  it('a definite rolled-back native head refusal becomes retryable failure, never unknown success', async () => {
    const r = runtime(),
      prepared = await r.worker.prepare('77', null, new AbortController().signal);
    await r.worker.advance(prepared.id, new AbortController().signal);
    await r.worker.advance(prepared.id, new AbortController().signal);
    native.initialize.mockRejectedValue(
      Object.assign(new Error('head changed'), { code: 'SCREENING_COUNTER_SOURCE_CHANGED' }),
    );
    expect((await r.worker.advance(prepared.id, new AbortController().signal)).phase).toBe(
      'failed',
    );
    expect(native.initialize).toHaveBeenCalledTimes(1);
  });
});
