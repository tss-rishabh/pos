import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { readConfig } from '../config.js';
import { createDatabases, type Databases } from '../db/pools.js';
import { AppError } from '../domain/errors.js';
import { z } from 'zod';
import {
  securityAlertWorker,
  securityWorkerOptions,
  retrySecurityAlert,
  type SecurityWorkerEvent,
} from './security-worker.js';

const workerRunId = randomUUID();
const log = (event: SecurityWorkerEvent) =>
  process.stdout.write(
    JSON.stringify({ ...event, requestId: event.requestId ?? workerRunId }) + '\n',
  );
const controller = new AbortController();
let db: Databases | undefined,
  stopping = false,
  worker: ReturnType<typeof securityAlertWorker> | undefined;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    stopping = true;
    controller.abort();
    void worker?.stop().catch(() => undefined);
  });
try {
  const options = securityWorkerOptions(),
    args = process.argv.slice(2);
  if (
    args.length > 0 &&
    !(args.length === 1 && args[0] === '--once') &&
    !(args.length === 2 && args[0] === '--retry-alert' && z.uuid().safeParse(args[1]).success)
  )
    throw new AppError(
      400,
      'INVALID_WORKER_ARGUMENT',
      'Choose one supported security worker action.',
    );
  if (args.length && !options.AUTH_SECURITY_WORKER_ENABLED)
    throw new AppError(
      503,
      'SECURITY_WORKER_DISABLED',
      'Enable the configured security worker before requesting recovery.',
    );
  if (options.AUTH_SECURITY_WORKER_ENABLED) {
    const config = readConfig();
    if (config.DEMO_MODE)
      throw new AppError(
        503,
        'SECURITY_WORKER_DEMO_FORBIDDEN',
        'Use an isolated service configuration.',
      );
    db = createDatabases(config);
    worker = securityAlertWorker(db, options, log);
    if (args[0] === '--retry-alert') {
      const trace = await retrySecurityAlert(db, args[1]!);
      log({
        module: 'identity',
        resource: 'login-security-alert',
        eventId: 'identity.login-security-alert.requeued',
        eventInstanceId: crypto.randomUUID(),
        ...trace,
      });
    } else
      do {
        try {
          await worker.runOnce();
        } catch {
          log({
            module: 'identity',
            resource: 'login-security-worker',
            eventId: 'identity.login-security-worker.batch.failed',
            eventInstanceId: crypto.randomUUID(),
            requestId: workerRunId,
            userId: null,
            errorCode: 'SECURITY_WORKER_UNAVAILABLE',
          });
          if (args.includes('--once')) process.exitCode = 1;
        }
        if (stopping || args.includes('--once')) break;
        try {
          await setTimeout(options.AUTH_SECURITY_POLL_MS, undefined, { signal: controller.signal });
        } catch {
          stopping = true;
        }
      } while (!stopping);
  } else
    log({
      module: 'identity',
      resource: 'login-security-worker',
      eventId: 'identity.login-security-worker.disabled',
      eventInstanceId: crypto.randomUUID(),
      requestId: workerRunId,
      userId: null,
    });
} catch (error) {
  log({
    module: 'identity',
    resource: 'login-security-worker',
    eventId: 'identity.login-security-worker.startup.failed',
    eventInstanceId: crypto.randomUUID(),
    requestId: workerRunId,
    userId: null,
    errorCode: error instanceof AppError ? error.code : 'SECURITY_WORKER_CONFIGURATION_INVALID',
  });
  process.exitCode = 1;
} finally {
  await worker?.stop().catch(() => undefined);
  await db?.close().catch(() => undefined);
}
