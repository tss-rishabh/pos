import { randomUUID } from 'node:crypto';
import { constants, openSync, readSync, fstatSync, closeSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/mysql2';
import { readConfig } from '../../../config.js';
import { databasePool, type Databases } from '../../../db/pools.js';
import { counterError, counterHash, counterCustomer } from './contracts.js';
import { readCounterGenerationOptions } from './counter-generation-options.js';
import { counterGenerationJournal } from './counter-generation-journal.js';
import { counterGenerationWorker } from './counter-generation-worker.js';
import {
  counterGenerationWarehouse,
  counterGenerationCredentialSchema,
} from './counter-generation-warehouse.js';
import { screeningCounterSourceCapture } from './publisher.js';
import { counterGenerationDemands } from './counter-generation-demands.js';
import {
  counterGenerationDiscovery,
  counterGenerationDiscoverySource,
} from './counter-generation-discovery.js';
function credentials(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64000)
      throw counterError('GENERATION_KEY_REQUIRED');
    const bytes = Buffer.alloc(64001);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size < 1 || size > 64000) throw counterError('GENERATION_KEY_REQUIRED');
    return counterGenerationCredentialSchema.parse(
      JSON.parse(bytes.subarray(0, size).toString('utf8')) as unknown,
    );
  } finally {
    closeSync(fd);
  }
}
function event(
  requestId: string,
  status:
    | 'disabled'
    | 'started'
    | 'stopped'
    | 'prepared'
    | 'advanced'
    | 'drained'
    | 'unavailable'
    | 'startup-failed'
    | 'shutdown-failed',
  extra?: { generationId?: string; phase?: string; processed?: number; unavailable?: number },
) {
  process[status.endsWith('failed') ? 'stderr' : 'stdout'].write(
    JSON.stringify({
      module: 'legacy-order-imports',
      resource: 'screening-counter-generation',
      eventId: 'legacy-order-imports.screening-counter-generation.' + status,
      eventInstanceId: randomUUID(),
      requestId,
      userId: null,
      timestamp: new Date().toISOString(),
      status,
      ...extra,
    }) + '\n',
  );
}
/** Explicit standalone worker. Import/disabled construction opens no resource.
 * Native source, projection writer, rewrite journal, BQ reader and BQ writer are
 * separately configured; the reports reader can never submit a write script. */
export async function runScreeningCounterGeneration(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
) {
  const requestId = randomUUID(),
    options = readCounterGenerationOptions(env);
  if (!options) {
    event(requestId, 'disabled');
    return;
  }
  if (
    args.length &&
    !(args[0] === 'prepare' && (args.length === 2 || args.length === 3)) &&
    !(args[0] === 'advance' && args.length === 2) &&
    !(args[0] === 'drain' && args.length === 1)
  )
    throw counterError('GENERATION_CONFIGURATION');
  if (args[0] === 'prepare') counterCustomer.parse(args[1]);
  if (args[0] === 'advance') counterHash.parse(args[1]);
  if (args[2]) counterHash.parse(args[2]);
  const config = readConfig(env);
  if (
    config.DEMO_MODE ||
    !config.MYSQL_WRITER_URL ||
    new Set([
      decodeURIComponent(new URL(config.MYSQL_WRITER_URL).username),
      decodeURIComponent(new URL(options.sourceUrl).username),
      decodeURIComponent(new URL(options.projectionUrl).username),
    ]).size !== 3
  )
    throw counterError('GENERATION_CONFIGURATION');
  if (realpathSync(options.readerKeyFile) === realpathSync(options.writerKeyFile))
    throw counterError('GENERATION_WRITER_REQUIRED');
  const reader = credentials(options.readerKeyFile),
    writer = credentials(options.writerKeyFile);
  if (
    reader.client_email === writer.client_email ||
    reader.private_key === writer.private_key ||
    writer.client_email === 'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com'
  )
    throw counterError('GENERATION_WRITER_REQUIRED');
  const pools: ReturnType<typeof databasePool>[] = [],
    controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined,
    pending: Promise<void> | undefined,
    finish: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    }),
    shutdown = () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      finish?.();
    };
  try {
    const journalPool = databasePool(config.MYSQL_WRITER_URL, config);
    pools.push(journalPool);
    const projectionPool = databasePool(options.projectionUrl, {
      ...config,
      MYSQL_TLS_CA_FILE: options.projectionTlsCaFile ?? config.MYSQL_TLS_CA_FILE,
    });
    pools.push(projectionPool);
    const sourcePool = options.newWorkEnabled
      ? databasePool(
          options.sourceUrl,
          { ...config, MYSQL_TLS_CA_FILE: options.sourceTlsCaFile ?? config.MYSQL_TLS_CA_FILE },
          true,
        )
      : undefined;
    if (sourcePool) pools.push(sourcePool);
    const journalDb = { get: () => drizzle(journalPool) },
      projection: Databases = { get: () => drizzle(projectionPool), close: async () => undefined },
      source = sourcePool
        ? screeningCounterSourceCapture(
            { get: () => drizzle(sourcePool) },
            options.sourceKey,
            Date.now,
            options.headMetadata,
          )
        : {
            async snapshot(): Promise<
              Awaited<ReturnType<ReturnType<typeof screeningCounterSourceCapture>['snapshot']>>
            > {
              throw counterError('GENERATION_DISABLED');
            },
            async capture(): Promise<
              Awaited<ReturnType<ReturnType<typeof screeningCounterSourceCapture>['capture']>>
            > {
              throw counterError('GENERATION_DISABLED');
            },
          },
      journal = counterGenerationJournal(journalDb, {
        journalKey: options.journalKey,
        sourceKey: options.sourceKey,
      }),
      warehouse = counterGenerationWarehouse(options, { reader, writer }),
      worker = counterGenerationWorker(options, {
        source,
        journal,
        warehouse,
        projection,
        enabled: () => options.newWorkEnabled && !controller.signal.aborted,
      });
    const discovery = sourcePool
      ? counterGenerationDiscovery(options, {
          source: counterGenerationDiscoverySource({ get: () => drizzle(sourcePool) }, options),
          demands: counterGenerationDemands(journalDb, options.journalKey),
          worker,
          journal,
          enabled: () => options.newWorkEnabled && !controller.signal.aborted,
        })
      : undefined;
    const runPass = async (signal: AbortSignal) => {
      const summary = { processed: 0, unavailable: 0 };
      if (discovery) {
        try {
          await discovery.discover(signal);
        } catch {
          summary.unavailable++;
        }
        if (!signal.aborted) {
          try {
            const prepared = await discovery.prepare(signal);
            summary.processed += prepared.processed;
            summary.unavailable += prepared.unavailable;
          } catch {
            summary.unavailable++;
          }
        }
      }
      if (!signal.aborted) {
        const advanced = await worker.drain(signal);
        summary.processed += advanced.processed;
        summary.unavailable += advanced.unavailable;
      }
      return summary;
    };
    if (args[0] === 'prepare') {
      const record = await worker.prepare(args[1]!, args[2] ?? null, AbortSignal.timeout(40000));
      event(requestId, 'prepared', { generationId: record.id, phase: record.phase });
      return;
    }
    if (args[0] === 'advance') {
      const record = await worker.advance(args[1]!, AbortSignal.timeout(40000));
      event(requestId, 'advanced', { generationId: record.id, phase: record.phase });
      return;
    }
    if (args[0] === 'drain') {
      event(requestId, 'drained', await runPass(AbortSignal.timeout(40000)));
      return;
    }
    const tick = async () => {
      try {
        const summary = await runPass(
          AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]),
        );
        if (summary.unavailable) event(requestId, 'unavailable', summary);
      } catch {
        if (!controller.signal.aborted) event(requestId, 'unavailable');
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            pending = tick();
          }, options.intervalMs);
      }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    event(requestId, 'started');
    pending = tick();
    await stopped;
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    const deadline = setTimeout(() => {
      event(requestId, 'shutdown-failed');
      process.exit(1);
    }, 45000);
    deadline.unref();
    try {
      await pending;
      await Promise.all(pools.map((pool) => pool.end()));
      event(requestId, 'stopped');
    } catch {
      event(requestId, 'shutdown-failed');
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runScreeningCounterGeneration();
  } catch {
    event(randomUUID(), 'startup-failed');
    process.exitCode = 1;
  }
}
