import type { Config } from '../config.js';
import type { Databases } from '../db/pools.js';
import type { JobHandlerRegistry, JobProducer } from './contract.js';
import type { EphemeralStore } from './ephemeral.js';

/** Structured log sink for jobs. Events carry ids only: never args, results or PII. */
export type JobLogger = (
  level: 'info' | 'warn' | 'error',
  event: Readonly<Record<string, string | number | boolean | null>>,
  message: string,
) => void;

/** Dependencies a module's job handlers receive in the worker process. */
export interface JobRuntime {
  config: Config;
  db: Databases;
  ephemeral: EphemeralStore;
  /** For jobs that enqueue follow-up jobs (legacy O3 enqueues C9). */
  jobs: JobProducer;
  log: JobLogger;
  /** Registers a resource (Redis client, notification bus) to close when the worker stops. */
  onClose?: (close: () => Promise<void>) => void;
}

/**
 * Every module that owns jobs exports `registerJobHandlers` with this signature from
 * `src/modules/<module>/jobs.ts`; `src/jobs/handlers.ts` calls each one.
 */
export type JobModuleRegistration = (registry: JobHandlerRegistry, runtime: JobRuntime) => void;
