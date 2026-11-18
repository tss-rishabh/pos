import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { currentRequestTrace } from '../observability/context.js';
import {
  JOB_NAMES,
  JOB_QUEUES,
  type EnqueuedJob,
  type JobArgs,
  type JobName,
  type JobProducer,
  type JobQueue,
} from './contract.js';
import { redisUnavailable, type RedisCommands } from './redis.js';

/**
 * Redis job queue replacing legacy Celery (phase-c-legacy-jobs.md §4).
 *
 * Keys (§4.3):
 * - `pos:jobs:q:{queue}`        LIST  ready job ids; producers LPUSH, workers move from the right.
 * - `pos:jobs:delayed`          ZSET  job id -> due epoch ms.
 * - `pos:jobs:job:{jobId}`      STRING JSON job record, EX 7 days (longer for long countdowns),
 *                                     refreshed on every state change.
 * - `pos:jobs:inflight:{worker}` LIST job ids claimed by that worker and not finished.
 * - `pos:jobs:worker:{worker}`  STRING heartbeat, EX 30, refreshed every 10 s.
 * - `pos:jobs:failed`           LIST  failed job ids, newest first, trimmed to 10 000.
 *
 * Every multi-key step is one Lua script, so it is atomic like the MULTI blocks in §4.4.
 * Delivery is at-most-once: a claimed job is never re-run automatically.
 */
export const JOB_RECORD_TTL_SECONDS = 604_800;
export const MAX_DELAY_SECONDS = 30 * 86_400;
export const FAILED_LIST_LIMIT = 10_000;
export const HEARTBEAT_TTL_SECONDS = 30;

export const jobKeys = {
  queue: (queue: JobQueue) => `pos:jobs:q:${queue}`,
  delayed: 'pos:jobs:delayed',
  jobPrefix: 'pos:jobs:job:',
  job: (jobId: string) => `pos:jobs:job:${jobId}`,
  inflightPrefix: 'pos:jobs:inflight:',
  inflight: (workerId: string) => `pos:jobs:inflight:${workerId}`,
  worker: (workerId: string) => `pos:jobs:worker:${workerId}`,
  failed: 'pos:jobs:failed',
  queuePrefix: 'pos:jobs:q:',
};

export const jobStates = ['queued', 'delayed', 'started', 'succeeded', 'failed'] as const;
export type JobState = (typeof jobStates)[number];

const scalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
export const jobArgsSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    z.union([scalar, z.array(scalar).max(10_000)]),
  )
  .refine((value) => Object.keys(value).length <= 64, 'Too many job arguments.');

export const jobRecordSchema = z
  .object({
    id: z.uuid(),
    state: z.enum(jobStates),
    name: z.enum(JOB_NAMES),
    queue: z.enum(JOB_QUEUES),
    /** Legacy Celery positional args. Producers pass keyword args only, so this stays empty. */
    args: z.array(scalar).max(0),
    kwargs: jobArgsSchema,
    enqueuedAt: z.number().int(),
    dueAt: z.number().int(),
    requestId: z.string().max(128).nullable(),
    userId: z.string().max(64).nullable(),
    startedAt: z.number().int().nullable(),
    finishedAt: z.number().int().nullable(),
    workerId: z.string().max(128).nullable(),
    errorCode: z.string().max(128).nullable(),
  })
  .strict();
export type JobRecord = z.infer<typeof jobRecordSchema>;

/**
 * `id` and `state` always come first so Lua can change the state with an anchored pattern
 * instead of decoding and re-encoding the record (cjson would rewrite large numbers).
 */
export function serializeJob(job: JobRecord): string {
  const parsed = jobRecordSchema.parse(job);
  return JSON.stringify({
    id: parsed.id,
    state: parsed.state,
    name: parsed.name,
    queue: parsed.queue,
    args: parsed.args,
    kwargs: parsed.kwargs,
    enqueuedAt: parsed.enqueuedAt,
    dueAt: parsed.dueAt,
    requestId: parsed.requestId,
    userId: parsed.userId,
    startedAt: parsed.startedAt,
    finishedAt: parsed.finishedAt,
    workerId: parsed.workerId,
    errorCode: parsed.errorCode,
  });
}
export function parseJob(raw: unknown): JobRecord | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = jobRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export const recordTtlSeconds = (dueAt: number, now: number) =>
  JOB_RECORD_TTL_SECONDS + Math.max(0, Math.ceil((dueAt - now) / 1000));

const enqueueNowScript = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('LPUSH', KEYS[2], ARGV[3])
return 1`;
const enqueueDelayedScript = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
return 1`;
/** KEYS[1] delayed ZSET; ARGV now, limit, job prefix, queue prefix, ttl. Safe to run concurrently. */
export const promoteScript = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local moved = 0
for _, id in ipairs(ids) do
  if redis.call('ZREM', KEYS[1], id) == 1 then
    local key = ARGV[3] .. id
    local raw = redis.call('GET', key)
    if raw then
      local ok, job = pcall(cjson.decode, raw)
      if ok and type(job) == 'table' and type(job.queue) == 'string' then
        local updated, count = string.gsub(raw, '^({"id":"[%w%-]+","state":")delayed(")', '%1queued%2', 1)
        if count == 1 then
          redis.call('SET', key, updated, 'EX', ARGV[5])
          redis.call('LPUSH', ARGV[4] .. job.queue, id)
          moved = moved + 1
        end
      end
    end
  end
end
return moved`;
/** KEYS job, inflight, failed; ARGV json, ttl, id, failed flag. */
const finishScript = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('LREM', KEYS[2], 1, ARGV[3])
if ARGV[4] == '1' then
  redis.call('LPUSH', KEYS[3], ARGV[3])
  redis.call('LTRIM', KEYS[3], 0, ${FAILED_LIST_LIMIT - 1})
end
return 1`;
/**
 * KEYS job, source list, worker heartbeat (orphans) or '' (failed), target queue;
 * ARGV id, expected state, new json, ttl, require-source flag.
 * Returns 1 requeued, 0 state changed or not in source, -1 worker alive.
 */
const requeueScript = `
if KEYS[3] ~= '' and redis.call('EXISTS', KEYS[3]) == 1 then return -1 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if not string.find(raw, '^{"id":"[%w%-]+","state":"' .. ARGV[2] .. '"') then return 0 end
local removed = redis.call('LREM', KEYS[2], 1, ARGV[1])
if ARGV[5] == '1' and removed ~= 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
redis.call('LPUSH', KEYS[4], ARGV[1])
return 1`;

const integerReply = (value: unknown) => {
  const parsed = z.number().int().safeParse(value);
  if (!parsed.success) throw redisUnavailable();
  return parsed.data;
};

export interface JobQueueClock {
  now(): number;
  id(): string;
}
const systemClock: JobQueueClock = { now: () => Date.now(), id: () => randomUUID() };

/** Producer used by the API process. Enqueue only after the caller's MySQL commit. */
export function redisJobProducer(
  redis: RedisCommands,
  clock: JobQueueClock = systemClock,
): JobProducer {
  return {
    async enqueue(name, args, options) {
      const jobName = z.enum(JOB_NAMES).parse(name),
        queue = z.enum(JOB_QUEUES).parse(options.queue),
        delaySeconds = z
          .number()
          .int()
          .min(0)
          .max(MAX_DELAY_SECONDS)
          .optional()
          .parse(options.delaySeconds),
        kwargs = jobArgsSchema.parse(args);
      if (JSON.stringify(kwargs).length > 65_536)
        throw new AppError(400, 'JOB_ARGUMENTS_TOO_LARGE', 'Job arguments are too large.');
      const now = clock.now(),
        id = clock.id(),
        delayed = Boolean(delaySeconds),
        dueAt = now + (delaySeconds ?? 0) * 1000,
        trace = currentRequestTrace();
      const record: JobRecord = {
        id,
        state: delayed ? 'delayed' : 'queued',
        name: jobName,
        queue,
        args: [],
        kwargs,
        enqueuedAt: now,
        dueAt,
        requestId: trace?.requestId ?? null,
        userId: trace?.userId ?? null,
        startedAt: null,
        finishedAt: null,
        workerId: null,
        errorCode: null,
      };
      const json = serializeJob(record),
        ttl = String(recordTtlSeconds(dueAt, now));
      if (delayed)
        await redis.evalScript(
          enqueueDelayedScript,
          [jobKeys.job(id), jobKeys.delayed],
          [json, ttl, String(dueAt), id],
        );
      else
        await redis.evalScript(
          enqueueNowScript,
          [jobKeys.job(id), jobKeys.queue(queue)],
          [json, ttl, id],
        );
      return { jobId: id, name: jobName, queue, dueAt } satisfies EnqueuedJob;
    },
  };
}

/** Used when Redis is not configured: enqueueing fails clearly instead of dropping work. */
export function unavailableJobProducer(): JobProducer {
  return {
    async enqueue(): Promise<EnqueuedJob> {
      throw new AppError(503, 'JOB_QUEUE_UNAVAILABLE', 'Background jobs are not configured.');
    },
  };
}

/** Low-level queue operations used by the worker and the operator CLI. */
export function jobQueueStore(
  redis: RedisCommands,
  clock: Pick<JobQueueClock, 'now'> = systemClock,
) {
  async function read(jobId: string) {
    return parseJob(await redis.send(['GET', jobKeys.job(jobId)]));
  }
  async function write(job: JobRecord) {
    const now = clock.now();
    await redis.send([
      'SET',
      jobKeys.job(job.id),
      serializeJob(job),
      'EX',
      String(recordTtlSeconds(job.dueAt, now)),
    ]);
  }
  return {
    read,
    write,
    async promote(limit = 100) {
      const now = clock.now();
      return integerReply(
        await redis.evalScript(
          promoteScript,
          [jobKeys.delayed],
          [
            String(now),
            String(limit),
            jobKeys.jobPrefix,
            jobKeys.queuePrefix,
            String(JOB_RECORD_TTL_SECONDS),
          ],
        ),
      );
    },
    async finish(job: JobRecord, workerId: string) {
      await redis.evalScript(
        finishScript,
        [jobKeys.job(job.id), jobKeys.inflight(workerId), jobKeys.failed],
        [
          serializeJob(job),
          String(JOB_RECORD_TTL_SECONDS),
          job.id,
          job.state === 'failed' ? '1' : '0',
        ],
      );
    },
    async heartbeat(workerId: string) {
      await redis.send([
        'SET',
        jobKeys.worker(workerId),
        String(clock.now()),
        'EX',
        String(HEARTBEAT_TTL_SECONDS),
      ]);
    },
    async retire(workerId: string) {
      const remaining = integerReply(await redis.send(['LLEN', jobKeys.inflight(workerId)]));
      if (remaining === 0) await redis.send(['DEL', jobKeys.inflight(workerId)]);
      await redis.send(['DEL', jobKeys.worker(workerId)]);
      return remaining;
    },
    async dropInflight(jobId: string, workerId: string) {
      await redis.send(['LREM', jobKeys.inflight(workerId), '1', jobId]);
    },
    /** Ids left in inflight lists of workers whose heartbeat expired (§4.4 "Crash"). */
    async listOrphans() {
      const inflightKeys = new Set<string>();
      let cursor = '0';
      do {
        const parsed = z
          .tuple([z.string(), z.array(z.string())])
          .safeParse(
            await redis.send([
              'SCAN',
              cursor,
              'MATCH',
              `${jobKeys.inflightPrefix}*`,
              'COUNT',
              '500',
            ]),
          );
        if (!parsed.success) throw redisUnavailable();
        cursor = parsed.data[0];
        for (const key of parsed.data[1]) inflightKeys.add(key);
      } while (cursor !== '0');
      const orphans: { workerId: string; jobId: string; job: JobRecord | null }[] = [];
      for (const key of [...inflightKeys].sort()) {
        const workerId = key.slice(jobKeys.inflightPrefix.length);
        if (integerReply(await redis.send(['EXISTS', jobKeys.worker(workerId)])) === 1) continue;
        const ids = z.array(z.string()).parse(await redis.send(['LRANGE', key, '0', '-1']));
        for (const jobId of ids) orphans.push({ workerId, jobId, job: await read(jobId) });
      }
      return orphans;
    },
    async listFailed(limit = 100) {
      const ids = z
        .array(z.string())
        .parse(await redis.send(['LRANGE', jobKeys.failed, '0', String(Math.max(0, limit - 1))]));
      const jobs: { jobId: string; job: JobRecord | null }[] = [];
      for (const jobId of ids) jobs.push({ jobId, job: await read(jobId) });
      return jobs;
    },
    /**
     * Operator re-run of one orphaned (worker dead) or failed job. Re-running is safe only for
     * jobs whose legacy body is guarded; the CLI prints that warning.
     */
    async requeue(
      jobId: string,
    ): Promise<'requeued' | 'not-found' | 'not-requeueable' | 'worker-alive'> {
      const job = await read(jobId);
      if (!job) return 'not-found';
      if (job.state !== 'started' && job.state !== 'failed') return 'not-requeueable';
      const orphan = job.state === 'started';
      if (orphan && !job.workerId) return 'not-requeueable';
      const next: JobRecord = {
        ...job,
        state: 'queued',
        startedAt: null,
        finishedAt: null,
        workerId: null,
        errorCode: null,
      };
      const result = integerReply(
        await redis.evalScript(
          requeueScript,
          [
            jobKeys.job(jobId),
            orphan ? jobKeys.inflight(job.workerId!) : jobKeys.failed,
            orphan ? jobKeys.worker(job.workerId!) : '',
            jobKeys.queue(job.queue),
          ],
          [
            jobId,
            job.state,
            serializeJob(next),
            String(JOB_RECORD_TTL_SECONDS),
            orphan ? '1' : '0',
          ],
        ),
      );
      return result === 1 ? 'requeued' : result === -1 ? 'worker-alive' : 'not-requeueable';
    },
  };
}
export type JobQueueStore = ReturnType<typeof jobQueueStore>;

/**
 * Claim one ready job id for this worker: non-blocking LMOVE over every queue (round-robin
 * start), then one short BLMOVE on the next queue. Uses the dedicated blocking connection.
 */
export function jobClaimer(
  blocking: RedisCommands,
  queues: readonly JobQueue[] = JOB_QUEUES,
  blockSeconds = 0.25,
) {
  let offset = 0;
  return async function claim(workerId: string): Promise<string | null> {
    const order = queues.map((_queue, index) => queues[(offset + index) % queues.length]!);
    offset = (offset + 1) % queues.length;
    for (const queue of order) {
      const id = await blocking.send([
        'LMOVE',
        jobKeys.queue(queue),
        jobKeys.inflight(workerId),
        'RIGHT',
        'LEFT',
      ]);
      if (typeof id === 'string') return id;
    }
    const id = await blocking.send(
      [
        'BLMOVE',
        jobKeys.queue(order[0]!),
        jobKeys.inflight(workerId),
        'RIGHT',
        'LEFT',
        String(blockSeconds),
      ],
      { timeoutMs: Math.ceil(blockSeconds * 1000) + 3000 },
    );
    return typeof id === 'string' ? id : null;
  };
}

export type { JobName, JobArgs };
