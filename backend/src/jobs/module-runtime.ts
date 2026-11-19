import type { Config } from '../config.js';
import type { EnqueuedJob, JobArgs, JobName, JobProducer, EnqueueOptions } from './contract.js';
import {
  memoryEphemeralStore,
  redisEphemeralStore,
  unavailableEphemeralStore,
  type EphemeralStore,
} from './ephemeral.js';
import { redisJobProducer, unavailableJobProducer } from './queue.js';
import { connectRedis } from './redis.js';

/** What the API process hands to W8 modules: a job producer and the ephemeral Redis state. */
export interface ModuleRuntime {
  jobs: JobProducer;
  ephemeral: EphemeralStore;
}

/**
 * Redis-backed when REDIS_URL is set. Without it, production fails closed (503), and
 * development/tests get in-process ephemeral state and a producer that refuses to enqueue.
 *
 * `queue` is the producer for callers that accept an optional one (W4/W5 checkout, fulfillment,
 * legacy-fulfillment): the Redis producer, or `jobsOverride` (tests), else `undefined` so those
 * callers keep their own "queue unavailable" handling. `jobs` is never undefined.
 */
export function createModuleRuntime(
  config: Config,
  jobsOverride?: JobProducer,
): ModuleRuntime & { queue: JobProducer | undefined; close(): Promise<void> } {
  if (config.REDIS_URL) {
    const redis = connectRedis(config.REDIS_URL, config.NODE_ENV),
      queue = jobsOverride ?? redisJobProducer(redis);
    return {
      jobs: queue,
      queue,
      ephemeral: redisEphemeralStore(redis),
      close: () => redis.close(),
    };
  }
  return {
    jobs: jobsOverride ?? unavailableJobProducer(),
    queue: jobsOverride,
    ephemeral:
      config.NODE_ENV === 'production' ? unavailableEphemeralStore() : memoryEphemeralStore(),
    close: async () => {},
  };
}

/** Test double: records enqueued jobs instead of sending them. */
export function recordingJobProducer(now: () => number = Date.now) {
  const enqueued: { name: JobName; args: JobArgs; options: EnqueueOptions; job: EnqueuedJob }[] =
    [];
  let sequence = 0;
  const producer: JobProducer & { enqueued: typeof enqueued } = {
    enqueued,
    async enqueue(name, args, options) {
      sequence++;
      const job: EnqueuedJob = {
        jobId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        name,
        queue: options.queue,
        dueAt: now() + (options.delaySeconds ?? 0) * 1000,
      };
      enqueued.push({ name, args, options, job });
      return job;
    },
  };
  return producer;
}
