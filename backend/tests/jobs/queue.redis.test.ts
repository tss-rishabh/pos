import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { privateRedisFixture } from '../helpers/private-redis.js';
import { connectRedis, type RedisCommands } from '../../src/jobs/redis.js';
import {
  jobClaimer,
  jobKeys,
  jobQueueStore,
  parseJob,
  redisJobProducer,
  serializeJob,
  type JobRecord,
} from '../../src/jobs/queue.js';
import { createJobHandlerRegistry } from '../../src/jobs/registry.js';
import { jobWorker } from '../../src/jobs/worker.js';
import { withRequestTrace, currentRequestTrace } from '../../src/observability/context.js';
import { AppError } from '../../src/domain/errors.js';
import {
  memoryEphemeralStore,
  redisEphemeralStore,
  withEphemeralLock,
} from '../../src/jobs/ephemeral.js';
import type { JobLogger } from '../../src/jobs/runtime.js';

const hasRedis = (() => {
  try {
    execFileSync('redis-server', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasRedis)('Redis job queue (private loopback redis-server)', () => {
  let fixture: Awaited<ReturnType<typeof privateRedisFixture>>;
  let redis: RedisCommands, blocking: RedisCommands;
  const events: { level: string; event: Record<string, unknown>; message: string }[] = [];
  const log: JobLogger = (level, event, message) =>
    events.push({ level, event: { ...event }, message });

  beforeAll(async () => {
    fixture = await privateRedisFixture();
    redis = connectRedis(fixture.url, 'test');
    blocking = connectRedis(fixture.url, 'test');
  });
  afterAll(async () => {
    await redis?.close();
    await blocking?.close();
    await fixture?.close();
  });
  beforeEach(async () => {
    await redis.send(['FLUSHDB']);
    events.length = 0;
  });

  it('enqueues now with LPUSH and a 7-day record carrying the request trace', async () => {
    const producer = redisJobProducer(redis);
    const job = await withRequestTrace(
      { requestId: 'req-1', userId: '42', module: 'administration', resource: 'inventory-import' },
      () =>
        producer.enqueue(
          'core.tasks.parse_csv_product_stock',
          { upload_id: '77', user_id: '42', role_id: 1 },
          { queue: 'core' },
        ),
    );
    expect(job.queue).toBe('core');
    expect(await redis.send(['LRANGE', jobKeys.queue('core'), '0', '-1'])).toEqual([job.jobId]);
    const record = parseJob(await redis.send(['GET', jobKeys.job(job.jobId)]))!;
    expect(record).toMatchObject({
      state: 'queued',
      name: 'core.tasks.parse_csv_product_stock',
      args: [],
      kwargs: { upload_id: '77', user_id: '42', role_id: 1 },
      requestId: 'req-1',
      userId: '42',
    });
    const ttl = Number(await redis.send(['TTL', jobKeys.job(job.jobId)]));
    expect(ttl).toBeGreaterThan(604_790);
    expect(ttl).toBeLessThanOrEqual(604_800);
  });

  it('rejects unknown names, queues and non-scalar arguments', async () => {
    const producer = redisJobProducer(redis);
    await expect(
      producer.enqueue('core.tasks.nope' as 'core.tasks.send_sms', {}, { queue: 'core' }),
    ).rejects.toThrow();
    await expect(
      producer.enqueue('core.tasks.send_sms', {}, { queue: 'celery' as 'core' }),
    ).rejects.toThrow();
    await expect(
      producer.enqueue(
        'core.tasks.send_sms',
        { order: { id: 1 } as unknown as string },
        { queue: 'core' },
      ),
    ).rejects.toThrow();
  });

  it('holds countdown jobs in the delayed ZSET and promotes them only when due', async () => {
    let now = 1_800_000_000_000;
    const clock = { now: () => now, id: () => '11111111-1111-4111-8111-111111111111' };
    const producer = redisJobProducer(redis, clock),
      store = jobQueueStore(redis, clock);
    const job = await producer.enqueue(
      'order.views.auto_hl_order_transfer',
      { order_id: '9' },
      { queue: 'order_create', delaySeconds: 90 },
    );
    expect(job.dueAt).toBe(now + 90_000);
    expect(Number(await redis.send(['ZSCORE', jobKeys.delayed, job.jobId]))).toBe(now + 90_000);
    expect(parseJob(await redis.send(['GET', jobKeys.job(job.jobId)]))!.state).toBe('delayed');
    expect(await store.promote()).toBe(0);
    now += 90_000;
    expect(await store.promote()).toBe(1);
    expect(await store.promote()).toBe(0);
    expect(await redis.send(['LRANGE', jobKeys.queue('order_create'), '0', '-1'])).toEqual([
      job.jobId,
    ]);
    const record = parseJob(await redis.send(['GET', jobKeys.job(job.jobId)]))!;
    expect(record.state).toBe('queued');
    expect(record.kwargs).toEqual({ order_id: '9' });
  });

  it('promotes each due job exactly once when promoters race', async () => {
    let sequence = 0;
    const now = 1_800_000_000_000;
    const producer = redisJobProducer(redis, {
      now: () => now - 1000,
      id: () => `22222222-2222-4222-8222-${String(++sequence).padStart(12, '0')}`,
    });
    for (let index = 0; index < 50; index++)
      await producer.enqueue(
        'order.views.advance_order_notification',
        { order_id: String(index) },
        { queue: 'order_create', delaySeconds: 1 },
      );
    const stores = [
      jobQueueStore(redis, { now: () => now }),
      jobQueueStore(connectRedis(fixture.url, 'test'), { now: () => now }),
    ];
    const moved = await Promise.all([
      stores[0]!.promote(7),
      stores[1]!.promote(7),
      stores[0]!.promote(100),
      stores[1]!.promote(100),
    ]);
    expect(moved.reduce((a, b) => a + b, 0)).toBe(50);
    expect(Number(await redis.send(['LLEN', jobKeys.queue('order_create')]))).toBe(50);
  });

  it('claims with LMOVE/BLMOVE into the inflight list, round-robin over queues', async () => {
    const producer = redisJobProducer(redis),
      claim = jobClaimer(blocking, ['core', 'export_queue']);
    const first = await producer.enqueue(
      'core.tasks.sync_ecom_inventory',
      { store_id: '5' },
      { queue: 'core' },
    );
    const second = await producer.enqueue(
      'report.datatables.cash_balance_datatable.do_cash_balance_export',
      { report_id: '1' },
      { queue: 'export_queue' },
    );
    const claimed = [await claim('w1'), await claim('w1')];
    expect(claimed.sort()).toEqual([first.jobId, second.jobId].sort());
    expect(await claim('w1')).toBeNull();
    expect(
      ((await redis.send(['LRANGE', jobKeys.inflight('w1'), '0', '-1'])) as string[]).sort(),
    ).toEqual(claimed.sort());
  });

  it('runs handlers at most once with the restored trace, records success and failure, never retries', async () => {
    const producer = redisJobProducer(redis),
      store = jobQueueStore(redis),
      handlers = createJobHandlerRegistry();
    const seen: unknown[] = [];
    let failures = 0;
    handlers.register('core.tasks.parse_csv_product_store', async (args, context) => {
      seen.push({
        args,
        trace: currentRequestTrace(),
        context: { requestId: context.requestId, userId: context.userId },
      });
    });
    handlers.register('core.tasks.parse_csv_product_stock', async () => {
      failures++;
      throw new AppError(422, 'CSV_INVALID', 'bad file');
    });
    const ok = await withRequestTrace(
      { requestId: 'req-ok', userId: '7', module: 'm', resource: 'r' },
      () =>
        producer.enqueue(
          'core.tasks.parse_csv_product_store',
          { upload_id: '1' },
          { queue: 'core' },
        ),
    );
    const bad = await producer.enqueue(
      'core.tasks.parse_csv_product_stock',
      { upload_id: '2' },
      { queue: 'core' },
    );
    const missing = await producer.enqueue(
      'core.tasks.send_sms',
      { order_id: '3' },
      { queue: 'core' },
    );
    const worker = jobWorker({
      store,
      claim: jobClaimer(blocking),
      handlers,
      log,
      concurrency: 2,
      promoteIntervalMs: 100,
      heartbeatIntervalMs: 1000,
      workerId: 'worker-a',
    });
    void worker.start();
    for (let attempt = 0; attempt < 100; attempt++) {
      const states = await Promise.all(
        [ok, bad, missing].map(async (job) => (await store.read(job.jobId))?.state),
      );
      if (states.every((state) => state === 'succeeded' || state === 'failed')) break;
      await sleep(50);
    }
    await sleep(300);
    await worker.stop();
    expect(seen).toEqual([
      {
        args: { upload_id: '1' },
        trace: { requestId: 'req-ok', userId: '7', module: 'jobs', resource: 'job' },
        context: { requestId: 'req-ok', userId: '7' },
      },
    ]);
    expect(failures).toBe(1);
    expect(await store.read(ok.jobId)).toMatchObject({
      state: 'succeeded',
      workerId: 'worker-a',
      errorCode: null,
    });
    expect(await store.read(bad.jobId)).toMatchObject({
      state: 'failed',
      errorCode: 'CSV_INVALID',
    });
    expect(await store.read(missing.jobId)).toMatchObject({
      state: 'failed',
      errorCode: 'JOB_HANDLER_MISSING',
    });
    expect(((await redis.send(['LRANGE', jobKeys.failed, '0', '-1'])) as string[]).sort()).toEqual(
      [bad.jobId, missing.jobId].sort(),
    );
    // Graceful stop removes the heartbeat and the empty inflight list.
    expect(await redis.send(['EXISTS', jobKeys.worker('worker-a')])).toBe(0);
    expect(await redis.send(['EXISTS', jobKeys.inflight('worker-a')])).toBe(0);
    // Logs carry ids, never args.
    expect(JSON.stringify(events)).not.toContain('upload_id');
    expect(
      events.some(
        (entry) =>
          entry.event.eventId === 'jobs.job.failed' && entry.event.errorCode === 'CSV_INVALID',
      ),
    ).toBe(true);
  });

  it('respects the concurrency limit and finishes in-flight jobs on graceful stop', async () => {
    const producer = redisJobProducer(redis),
      store = jobQueueStore(redis),
      handlers = createJobHandlerRegistry();
    let active = 0,
      peak = 0,
      done = 0;
    handlers.register('report.datatables.sales_data.do_sales_export', async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(150);
      active--;
      done++;
    });
    for (let index = 0; index < 5; index++)
      await producer.enqueue(
        'report.datatables.sales_data.do_sales_export',
        { report_id: String(index) },
        { queue: 'sales_queue' },
      );
    const worker = jobWorker({
      store,
      claim: jobClaimer(blocking),
      handlers,
      log,
      concurrency: 2,
      promoteIntervalMs: 100,
      heartbeatIntervalMs: 1000,
      workerId: 'worker-b',
    });
    void worker.start();
    await sleep(200);
    await worker.stop();
    expect(peak).toBe(2);
    // Whatever was claimed finished; unclaimed jobs stay queued for the next worker.
    const queued = Number(await redis.send(['LLEN', jobKeys.queue('sales_queue')]));
    expect(done + queued).toBe(5);
    expect(await redis.send(['EXISTS', jobKeys.inflight('worker-b')])).toBe(0);
  });

  it('lists orphans of dead workers and requeues one only on purpose', async () => {
    const producer = redisJobProducer(redis),
      store = jobQueueStore(redis);
    const job = await producer.enqueue(
      'order.tasks.auto_reject_timed_out_for_store',
      { store_id: '3' },
      { queue: 'order' },
    );
    // Simulate a worker that claimed the job, marked it started, then died (no heartbeat).
    await redis.send(['LMOVE', jobKeys.queue('order'), jobKeys.inflight('dead'), 'RIGHT', 'LEFT']);
    const started: JobRecord = {
      ...(await store.read(job.jobId))!,
      state: 'started',
      startedAt: Date.now(),
      workerId: 'dead',
    };
    await store.write(started);
    await redis.send(['SET', jobKeys.worker('alive'), '1', 'EX', '30']);
    await redis.send(['LPUSH', jobKeys.inflight('alive'), 'x']);
    const orphans = await store.listOrphans();
    expect(orphans.map((orphan) => [orphan.workerId, orphan.jobId])).toEqual([['dead', job.jobId]]);
    // While the dead worker's heartbeat is back, requeue refuses.
    await redis.send(['SET', jobKeys.worker('dead'), '1', 'EX', '30']);
    expect(await store.requeue(job.jobId)).toBe('worker-alive');
    await redis.send(['DEL', jobKeys.worker('dead')]);
    expect(await store.requeue(job.jobId)).toBe('requeued');
    expect(await store.requeue(job.jobId)).toBe('not-requeueable');
    expect(await redis.send(['LRANGE', jobKeys.queue('order'), '0', '-1'])).toEqual([job.jobId]);
    expect(await redis.send(['LLEN', jobKeys.inflight('dead')])).toBe(0);
    expect(await store.read(job.jobId)).toMatchObject({
      state: 'queued',
      workerId: null,
      startedAt: null,
    });
  });

  it('requeues a failed job once', async () => {
    const store = jobQueueStore(redis);
    const failed: JobRecord = {
      id: '33333333-3333-4333-8333-333333333333',
      state: 'failed',
      name: 'core.tasks.sync_ecom_inventory',
      queue: 'core',
      args: [],
      kwargs: { store_id: '1' },
      enqueuedAt: 1,
      dueAt: 1,
      requestId: null,
      userId: null,
      startedAt: 2,
      finishedAt: 3,
      workerId: 'w',
      errorCode: 'JOB_FAILED',
    };
    await redis.send(['SET', jobKeys.job(failed.id), serializeJob(failed)]);
    await redis.send(['LPUSH', jobKeys.failed, failed.id]);
    expect(await store.requeue(failed.id)).toBe('requeued');
    expect(await store.requeue(failed.id)).toBe('not-requeueable');
    expect(await redis.send(['LLEN', jobKeys.failed])).toBe(0);
    expect(await store.requeue('44444444-4444-4444-8444-444444444444')).toBe('not-found');
  });

  it('shares lock and list semantics between the Redis and in-memory ephemeral stores', async () => {
    for (const store of [redisEphemeralStore(redis), memoryEphemeralStore()]) {
      expect(await store.set('k', 'a', { NX: true, EX: 60 })).toBe(true);
      expect(await store.set('k', 'b', { NX: true, EX: 60 })).toBe(false);
      expect(await store.delIfEquals('k', 'b')).toBe(false);
      expect(await store.delIfEquals('k', 'a')).toBe(true);
      expect(await store.get('k')).toBeNull();
      await store.lPush('check_in_list_1', '5', '6', '5');
      expect(await store.lRange('check_in_list_1', 0, -1)).toEqual(['5', '6', '5']);
      expect(await store.lRem('check_in_list_1', 0, '5')).toBe(2);
      expect(await store.lRange('check_in_list_1', 0, -1)).toEqual(['6']);
      expect((await store.scanKeys('check_in_list_*')).sort()).toEqual(['check_in_list_1']);
      expect(await store.ttl('check_in_list_1')).toBe(-1);
      expect(await store.incr('n')).toBe(1);
      const first = await withEphemeralLock(store, 'lock', 10_000, async () =>
        withEphemeralLock(store, 'lock', 10_000, async () => 1),
      );
      expect(first).toEqual({ value: null });
      expect(await store.get('lock')).toBeNull();
      await store.del('check_in_list_1', 'n');
    }
  });
});
