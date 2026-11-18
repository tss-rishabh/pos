import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../domain/errors.js';
import { withRequestTrace } from '../observability/context.js';
import type { JobContext } from './contract.js';
import type { JobRecord, JobQueueStore } from './queue.js';
import type { JobHandlerTable } from './registry.js';
import type { JobLogger } from './runtime.js';

export interface JobWorkerDependencies {
  store: JobQueueStore;
  /** Claims one id into this worker's inflight list (BLMOVE on a dedicated connection). */
  claim: (workerId: string) => Promise<string | null>;
  handlers: JobHandlerTable;
  log: JobLogger;
  concurrency: number;
  promoteIntervalMs: number;
  heartbeatIntervalMs: number;
  workerId?: string;
  now?: () => number;
}

const event = (
  job: Pick<JobRecord, 'id' | 'name' | 'queue' | 'requestId' | 'userId'>,
  outcome: string,
  extra: Record<string, string | number | null> = {},
) => ({
  module: 'jobs',
  resource: 'job',
  eventId: `jobs.job.${outcome}`,
  eventInstanceId: randomUUID(),
  requestId: job.requestId ?? job.id,
  userId: job.userId,
  jobId: job.id,
  jobName: job.name,
  queue: job.queue,
  ...extra,
});
const errorCode = (error: unknown) =>
  error instanceof AppError
    ? error.code
    : error instanceof Error && error.name === 'AbortError'
      ? 'JOB_ABORTED'
      : 'JOB_FAILED';

/**
 * One worker process: a promoter loop (1 s), a heartbeat (10 s), and a claim loop feeding
 * `concurrency` slots. At-most-once: a job is marked started before its handler runs and is
 * never retried. `stop()` stops claiming and waits for in-flight jobs; `abort()` signals them.
 */
export function jobWorker(dependencies: JobWorkerDependencies) {
  const workerId = dependencies.workerId ?? `${process.pid}-${randomUUID()}`,
    now = dependencies.now ?? (() => Date.now()),
    controller = new AbortController(),
    running = new Set<Promise<void>>();
  let active = false,
    loops: Promise<void> | undefined,
    wake: (() => void) | undefined;
  const lifecycle = (eventId: string, extra: Record<string, string | number | null> = {}) => ({
    module: 'jobs',
    resource: 'worker',
    eventId: `jobs.worker.${eventId}`,
    eventInstanceId: randomUUID(),
    requestId: workerId,
    userId: null,
    workerId,
    ...extra,
  });

  async function execute(id: string) {
    const job = await dependencies.store.read(id).catch(() => null);
    if (!job || job.state !== 'queued') {
      await dependencies.store.dropInflight(id, workerId).catch(() => undefined);
      dependencies.log(
        'warn',
        lifecycle('job-skipped', { jobId: id }),
        'Claimed job record is missing or not queued',
      );
      return;
    }
    const started: JobRecord = { ...job, state: 'started', startedAt: now(), workerId };
    try {
      await dependencies.store.write(started);
    } catch {
      // The id stays in this worker's inflight list; an operator can requeue it as an orphan.
      dependencies.log('error', event(job, 'start-unrecorded'), 'Job start could not be recorded');
      return;
    }
    dependencies.log('info', event(job, 'started', { workerId }), 'Job started');
    const handler = dependencies.handlers.handler(job.name);
    let outcome: JobRecord;
    if (!handler)
      outcome = {
        ...started,
        state: 'failed',
        finishedAt: now(),
        errorCode: 'JOB_HANDLER_MISSING',
      };
    else {
      const context: JobContext = {
        jobId: job.id,
        name: job.name,
        requestId: job.requestId,
        userId: job.userId,
        signal: controller.signal,
      };
      try {
        await withRequestTrace(
          {
            requestId: job.requestId ?? job.id,
            userId: job.userId,
            module: 'jobs',
            resource: 'job',
          },
          () => handler(job.kwargs, context),
        );
        outcome = { ...started, state: 'succeeded', finishedAt: now() };
      } catch (error) {
        outcome = { ...started, state: 'failed', finishedAt: now(), errorCode: errorCode(error) };
      }
    }
    try {
      await dependencies.store.finish(outcome, workerId);
    } catch {
      dependencies.log(
        'error',
        event(job, 'finish-unrecorded'),
        'Job outcome could not be recorded',
      );
    }
    if (outcome.state === 'succeeded')
      dependencies.log(
        'info',
        event(job, 'succeeded', { durationMs: outcome.finishedAt! - started.startedAt! }),
        'Job succeeded',
      );
    else
      dependencies.log(
        'warn',
        event(job, 'failed', { errorCode: outcome.errorCode }),
        'Job failed',
      );
  }

  async function heartbeatLoop() {
    while (active) {
      await dependencies.store
        .heartbeat(workerId)
        .catch(() =>
          dependencies.log('warn', lifecycle('heartbeat-failed'), 'Worker heartbeat failed'),
        );
      await sleep(dependencies.heartbeatIntervalMs, undefined, { signal: stopSignal() }).catch(
        () => undefined,
      );
    }
  }
  async function promoteLoop() {
    while (active) {
      try {
        while (active && (await dependencies.store.promote()) >= 100);
      } catch {
        dependencies.log('warn', lifecycle('promote-failed'), 'Delayed job promotion failed');
      }
      await sleep(dependencies.promoteIntervalMs, undefined, { signal: stopSignal() }).catch(
        () => undefined,
      );
    }
  }
  async function claimLoop() {
    while (active) {
      if (running.size >= dependencies.concurrency) {
        await new Promise<void>((resolve) => (wake = resolve));
        continue;
      }
      let id: string | null;
      try {
        id = await dependencies.claim(workerId);
      } catch {
        dependencies.log('warn', lifecycle('claim-failed'), 'Job claim failed; retrying');
        await sleep(1000, undefined, { signal: stopSignal() }).catch(() => undefined);
        continue;
      }
      if (!id) continue;
      const task = execute(id).finally(() => {
        running.delete(task);
        wake?.();
        wake = undefined;
      });
      running.add(task);
    }
  }
  let stopController = new AbortController();
  const stopSignal = () => stopController.signal;

  return {
    workerId,
    start() {
      if (active) return loops!;
      active = true;
      stopController = new AbortController();
      dependencies.log(
        'info',
        lifecycle('started', { concurrency: dependencies.concurrency }),
        'Job worker started',
      );
      loops = Promise.all([heartbeatLoop(), promoteLoop(), claimLoop()]).then(() => undefined);
      return loops;
    },
    /** Graceful stop: stop claiming, finish in-flight jobs, then remove this worker's keys. */
    async stop() {
      if (!active) return;
      active = false;
      stopController.abort();
      wake?.();
      await loops;
      await Promise.allSettled([...running]);
      const remaining = await dependencies.store.retire(workerId).catch(() => -1);
      dependencies.log('info', lifecycle('stopped', { remaining }), 'Job worker stopped');
    },
    /** Signal in-flight handlers to abort (second shutdown signal). */
    abort() {
      controller.abort();
    },
    inFlight: () => running.size,
  };
}
export type JobWorker = ReturnType<typeof jobWorker>;
