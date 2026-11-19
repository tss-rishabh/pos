import Fastify, { LogController } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../config.js';
import { createDatabases, type Databases } from '../db/pools.js';
import { AppError } from '../domain/errors.js';
import { redisEphemeralStore } from './ephemeral.js';
import { registerAllJobHandlers } from './handlers.js';
import { readJobWorkerOptions } from './options.js';
import { jobClaimer, jobQueueStore, redisJobProducer, type JobRecord } from './queue.js';
import { connectRedis, type RedisCommands } from './redis.js';
import { createJobHandlerRegistry } from './registry.js';
import type { JobLogger } from './runtime.js';
import { jobWorker } from './worker.js';
import { applicationLogger } from '../observability/logger.js';

/**
 * `npm run worker:jobs` — the single job worker (phase-c-legacy-jobs.md §4.5), replacing
 * `celery -A POSAdmin worker -Q core,store,order_create,export_queue,report_queue,sales_queue,order`.
 *
 *   worker:jobs                      consume all seven queues (JOBS_CONCURRENCY, default 2)
 *   worker:jobs --list-orphans       list jobs left in-flight by workers whose heartbeat expired
 *   worker:jobs --list-failed        list the newest failed jobs
 *   worker:jobs --requeue <jobId>    re-run one orphaned or failed job on purpose
 */
export const REQUEUE_WARNING =
  'WARNING: jobs are at-most-once, like legacy Celery. Re-running a job repeats its side effects. ' +
  'Requeue only jobs whose legacy body is guarded against repeats (the express_reject_lock ' +
  'auto-reject job, the hyperlocal_order_log-guarded transfer/conversion jobs) or after checking ' +
  'that the first run left no effect (pos_csv_upload, report_exports, gift_card_collection rows).';

class PrivateWorkerLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }
}
const runId = randomUUID();
// Job handler logs carry the originating request's trace (restored by the worker from the job
// record); worker lifecycle lines fall back to this run's ID.
const runtime = Fastify({
  logger: applicationLogger({}, { requestId: runId, module: 'jobs', resource: 'worker' }),
  logController: new PrivateWorkerLogController(),
});
const log: JobLogger = (level, event, message) => runtime.log[level]({ ...event }, message);
const describe = (entry: { jobId: string; job: JobRecord | null; workerId?: string }) =>
  JSON.stringify({
    jobId: entry.jobId,
    workerId: entry.workerId ?? entry.job?.workerId ?? null,
    name: entry.job?.name ?? null,
    queue: entry.job?.queue ?? null,
    state: entry.job?.state ?? 'missing',
    enqueuedAt: entry.job ? new Date(entry.job.enqueuedAt).toISOString() : null,
    startedAt: entry.job?.startedAt ? new Date(entry.job.startedAt).toISOString() : null,
    errorCode: entry.job?.errorCode ?? null,
    requestId: entry.job?.requestId ?? null,
  });

let databases: Databases | undefined;
const connections: RedisCommands[] = [];
/** Module resources (order Redis, notification bus) registered by the job handlers. */
const moduleClosers: (() => Promise<void>)[] = [];
async function closeAll() {
  await Promise.allSettled(moduleClosers.map((close) => close()));
  await Promise.allSettled(connections.map((connection) => connection.close()));
  await databases?.close();
  await runtime.close();
}
try {
  const config = readConfig(),
    args = process.argv.slice(2);
  if (!config.REDIS_URL)
    throw new AppError(503, 'JOBS_REDIS_REQUIRED', 'Configure REDIS_URL for the job worker.');
  const redis = connectRedis(config.REDIS_URL, config.NODE_ENV);
  connections.push(redis);
  const store = jobQueueStore(redis);
  if (args[0] === '--list-orphans' && args.length === 1) {
    process.stdout.write(`${REQUEUE_WARNING}\n`);
    for (const orphan of await store.listOrphans()) process.stdout.write(`${describe(orphan)}\n`);
    await closeAll();
  } else if (args[0] === '--list-failed' && args.length === 1) {
    for (const failed of await store.listFailed()) process.stdout.write(`${describe(failed)}\n`);
    await closeAll();
  } else if (args[0] === '--requeue' && args.length === 2 && /^[0-9a-f-]{36}$/.test(args[1]!)) {
    process.stdout.write(`${REQUEUE_WARNING}\n`);
    const result = await store.requeue(args[1]!);
    process.stdout.write(`${JSON.stringify({ jobId: args[1], result })}\n`);
    if (result !== 'requeued') process.exitCode = 2;
    await closeAll();
  } else if (args.length) {
    throw new AppError(
      400,
      'JOBS_ARGUMENTS_INVALID',
      'Use --list-orphans, --list-failed or --requeue <jobId>.',
    );
  } else {
    const options = readJobWorkerOptions(),
      blocking = connectRedis(config.REDIS_URL, config.NODE_ENV);
    connections.push(blocking);
    databases = createDatabases(config);
    const handlers = createJobHandlerRegistry();
    registerAllJobHandlers(handlers, {
      config,
      db: databases,
      ephemeral: redisEphemeralStore(redis),
      jobs: redisJobProducer(redis),
      log,
      onClose: (close) => moduleClosers.push(close),
    });
    const worker = jobWorker({
      store,
      claim: jobClaimer(blocking),
      handlers,
      log,
      concurrency: options.JOBS_CONCURRENCY,
      promoteIntervalMs: options.JOBS_PROMOTE_INTERVAL_MS,
      heartbeatIntervalMs: options.JOBS_HEARTBEAT_INTERVAL_MS,
    });
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
      process.on(signal, async () => {
        if (stopping) {
          // Second signal: ask handlers to abort, then exit shortly after.
          worker.abort();
          setTimeout(() => process.exit(1), 10_000).unref();
          return;
        }
        stopping = true;
        await worker.stop();
        await closeAll();
      });
    void worker.start();
  }
} catch (error) {
  log(
    'error',
    {
      module: 'jobs',
      resource: 'worker',
      eventId: 'jobs.worker.startup-failed',
      eventInstanceId: randomUUID(),
      requestId: runId,
      userId: null,
      errorCode: error instanceof AppError ? error.code : 'JOBS_WORKER_CONFIGURATION_INVALID',
    },
    'Job worker could not start',
  );
  await closeAll();
  process.exitCode = 1;
}
