import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildOriginHistoryBridgeRuntime, originHistoryBridgeLifecycle } from './bridge-runtime.js';

function event(value: object, failed = false) {
  try {
    process[failed ? 'stderr' : 'stdout'].write(JSON.stringify(value) + '\n');
  } catch {
    /* Log sinks cannot change service state. */
  }
}

export async function runOriginHistoryBridge(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
) {
  const requestId = randomUUID();
  let runtime: Awaited<ReturnType<typeof buildOriginHistoryBridgeRuntime>> | undefined;
  let signal: (() => void) | undefined;
  try {
    if (args.length) throw new Error('No arguments accepted.');
    runtime = await buildOriginHistoryBridgeRuntime(env, (value) =>
      event(value, value.status >= 500),
    );
    if (!runtime.enabled) {
      event(originHistoryBridgeLifecycle('disabled', requestId));
      return;
    }
    const server = runtime;
    let stopping: Promise<void> | undefined;
    signal = () => {
      stopping ??= (async () => {
        const deadline = setTimeout(() => {
          event(originHistoryBridgeLifecycle('shutdown-failed', requestId), true);
          process.exit(1);
        }, 40000);
        deadline.unref();
        try {
          await server.stop();
          event(originHistoryBridgeLifecycle('stopped', requestId));
        } catch {
          event(originHistoryBridgeLifecycle('shutdown-failed', requestId), true);
          process.exitCode = 1;
        } finally {
          clearTimeout(deadline);
          process.off('SIGINT', signal!);
          process.off('SIGTERM', signal!);
        }
      })();
    };
    process.once('SIGINT', signal);
    process.once('SIGTERM', signal);
    await server.listen();
    event(originHistoryBridgeLifecycle('started', requestId));
  } catch {
    if (signal) {
      process.off('SIGINT', signal);
      process.off('SIGTERM', signal);
    }
    await runtime?.stop().catch(() => undefined);
    event(originHistoryBridgeLifecycle('startup-failed', requestId), true);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOriginHistoryBridge();
