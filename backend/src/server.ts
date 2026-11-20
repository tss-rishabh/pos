import { readConfig } from './config.js';
import { buildApp } from './app.js';
import { AppError } from './domain/errors.js';

type Application = Awaited<ReturnType<typeof buildApp>>;
let app: Application | undefined;
function lifecycle(
  eventId: 'runtime.server.startup.failed' | 'runtime.server.shutdown.failed',
  errorCode?: string,
) {
  return {
    eventId,
    eventInstanceId: crypto.randomUUID(),
    module: 'runtime',
    resource: 'server',
    requestId: null,
    userId: null,
    ...(errorCode ? { errorCode } : {}),
  };
}
function safeCode(error: unknown) {
  if (error instanceof AppError) return error.code;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    ['EADDRINUSE', 'EADDRNOTAVAIL', 'EACCES', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code)
  )
    return error.code;
  return 'CONFIGURATION_OR_STARTUP_FAILED';
}
try {
  const config = readConfig();
  app = await buildApp(config, { logger: true });
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => process.exit(1), 10000);
      deadline.unref();
      void app
        ?.close()
        .catch(() => {
          app?.log.error(
            lifecycle('runtime.server.shutdown.failed', 'SHUTDOWN_FAILED'),
            'Server shutdown failed',
          );
          process.exitCode = 1;
        })
        .finally(() => clearTimeout(deadline));
    });
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  const event = lifecycle('runtime.server.startup.failed', safeCode(error));
  if (app) app.log.error(event, 'Server startup failed');
  else process.stderr.write(JSON.stringify({ ...event, message: 'Server startup failed' }) + '\n');
  await app?.close().catch(() => undefined);
  process.exitCode = 1;
}
