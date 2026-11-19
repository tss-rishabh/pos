import { JOB_NAMES, type JobHandler, type JobHandlerRegistry, type JobName } from './contract.js';

export interface JobHandlerTable extends JobHandlerRegistry {
  handler(name: JobName): JobHandler | undefined;
  registered(): JobName[];
}

/** In-memory handler table. Registering a name twice is a programming error. */
export function createJobHandlerRegistry(): JobHandlerTable {
  const handlers = new Map<JobName, JobHandler>();
  return {
    register(name, handler) {
      if (!(JOB_NAMES as readonly string[]).includes(name))
        throw new Error(`Unknown job name: ${name}`);
      if (handlers.has(name)) throw new Error(`Job handler registered twice: ${name}`);
      handlers.set(name, handler);
    },
    handler: (name) => handlers.get(name),
    registered: () => JOB_NAMES.filter((name) => handlers.has(name)),
  };
}
