import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { readConfig, type Config } from '../../../config.js';
import { createDatabases, type Databases } from '../../../db/pools.js';
import { AppError } from '../../../domain/errors.js';
import type { DocumentationMediaStore } from '../media-storage.js';
import type { ImageCleanupEvent, ownedImageCleanup } from './cleanup.js';

type Worker = ReturnType<typeof ownedImageCleanup>;
export interface ImageWorkerResource {
  store: DocumentationMediaStore;
  worker: Worker;
  retry: (id: string) => Promise<{ jobId: string; requestId: string | null; userId: string }>;
}
/** Supervise a bounded owner-adapted worker. Construction is lazy and disabled by default. */
export async function runOwnedImageWorker(
  options: {
    envPrefix: string;
    errorPrefix: string;
    module: string;
    resource: string;
    build: (
      config: Config,
      db: Databases,
      log: (event: ImageCleanupEvent) => void,
    ) => ImageWorkerResource;
  },
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv.slice(2),
  log: (event: ImageCleanupEvent) => void = (event) => {
    process.stdout.write(JSON.stringify(event) + '\n');
  },
) {
  const abort = new AbortController();
  const event = (action: string, errorCode?: string): ImageCleanupEvent => ({
    module: options.module,
    resource: options.resource,
    eventId: `${options.module}.${options.resource}.cleanup.${action}`,
    eventInstanceId: crypto.randomUUID(),
    requestId: null,
    userId: null,
    ...(errorCode ? { errorCode } : {}),
  });
  let db: Databases | undefined, resource: ImageWorkerResource | undefined;
  const shutdown = () => {
    abort.abort();
    void resource?.worker.stop().catch(() => undefined);
  };
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.on(name, shutdown);
  try {
    const enabled = z
      .preprocess(
        (value) =>
          value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
        z.boolean(),
      )
      .parse(env[`${options.envPrefix}_WORKER_ENABLED`]);
    const interval = z.coerce
      .number()
      .int()
      .min(1000)
      .max(60000)
      .default(30000)
      .parse(env[`${options.envPrefix}_WORKER_INTERVAL_MS`]);
    if (
      args.length &&
      !(args.length === 1 && args[0] === '--once') &&
      !(args.length === 2 && args[0] === '--retry-job' && z.uuid().safeParse(args[1]).success)
    )
      throw new AppError(400, 'INVALID_WORKER_ARGUMENT', 'Choose a supported image worker action.');
    if (!enabled) {
      if (args.length)
        throw new AppError(
          503,
          `${options.errorPrefix}_WORKER_DISABLED`,
          'Enable the image worker first.',
        );
      log(event('disabled'));
      return;
    }
    const config = readConfig(env);
    if (config.DEMO_MODE)
      throw new AppError(
        503,
        `${options.errorPrefix}_WORKER_DEMO_FORBIDDEN`,
        'Use an isolated service configuration.',
      );
    db = createDatabases(config);
    resource = options.build(config, db, log);
    if (args[0] === '--retry-job')
      log({ ...event('requeued'), ...(await resource.retry(args[1]!)) });
    else
      do {
        try {
          await resource.worker.runOnce();
        } catch {
          log(event('batch-failed', `${options.errorPrefix}_CLEANUP_UNAVAILABLE`));
          if (args.length) process.exitCode = 1;
        }
        if (args.length || abort.signal.aborted) break;
        await setTimeout(interval, undefined, { signal: abort.signal }).catch(() => undefined);
      } while (!abort.signal.aborted);
  } catch (error) {
    log(
      event(
        'startup-failed',
        error instanceof AppError ? error.code : `${options.errorPrefix}_CONFIGURATION_INVALID`,
      ),
    );
    process.exitCode = 1;
  } finally {
    for (const name of ['SIGINT', 'SIGTERM'] as const) process.removeListener(name, shutdown);
    await resource?.worker.stop().catch(() => undefined);
    resource?.store.close();
    await db?.close().catch(() => undefined);
  }
}
