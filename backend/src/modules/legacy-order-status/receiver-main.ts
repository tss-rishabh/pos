import { randomUUID } from 'node:crypto';
import { buildPrivateWholeOrderStatusRuntime, privateReceiverLifecycle } from './runtime.js';

const requestId = randomUUID();
let runtime: Awaited<ReturnType<typeof buildPrivateWholeOrderStatusRuntime>> | undefined;
const startupFailed = () => {
  process.stderr.write(
    JSON.stringify({ level: 50, ...privateReceiverLifecycle('startup-failed', requestId) }) + '\n',
  );
  process.exitCode = 1;
};
try {
  if (process.argv.length !== 2) throw new Error('Private receiver accepts no arguments.');
  runtime = await buildPrivateWholeOrderStatusRuntime();
  if (!runtime.enabled) {
    process.stdout.write(
      JSON.stringify({ level: 30, ...privateReceiverLifecycle('disabled', requestId) }) + '\n',
    );
  } else {
    const server = runtime;
    let stopping: Promise<void> | undefined;
    const stop = () =>
      (stopping ??= server.stop().then(() => {
        server.app.log.info(
          privateReceiverLifecycle('stopped', requestId),
          'Private STORE receiver stopped.',
        );
      }));
    const shutdown = () => {
      void stop().catch(() => {
        process.stderr.write(
          JSON.stringify({ level: 50, ...privateReceiverLifecycle('shutdown-failed', requestId) }) +
            '\n',
        );
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await server.listen();
    server.app.log.info(
      privateReceiverLifecycle('started', requestId),
      'Private STORE receiver listening.',
    );
  }
} catch {
  await runtime?.stop().catch(() => undefined);
  startupFailed();
}
