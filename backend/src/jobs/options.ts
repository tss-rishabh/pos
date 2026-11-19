import { z } from 'zod';

/** Worker settings. Legacy: `celery worker --concurrency=2` (Dockerfile.celery:64). */
export function readJobWorkerOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      JOBS_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
      JOBS_PROMOTE_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
      JOBS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).max(20_000).default(10_000),
    })
    .parse({
      JOBS_CONCURRENCY: env.JOBS_CONCURRENCY || undefined,
      JOBS_PROMOTE_INTERVAL_MS: env.JOBS_PROMOTE_INTERVAL_MS || undefined,
      JOBS_HEARTBEAT_INTERVAL_MS: env.JOBS_HEARTBEAT_INTERVAL_MS || undefined,
    });
}
export type JobWorkerOptions = ReturnType<typeof readJobWorkerOptions>;
