import { randomUUID } from 'node:crypto';
import { openSync, readSync, fstatSync, closeSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { drizzle } from 'drizzle-orm/mysql2';
import { z } from 'zod';
import { readConfig } from '../../../config.js';
import { databasePool } from '../../../db/pools.js';
import { generationError, generationWriterContract } from './history-generation-contracts.js';
import { generationSourceOrigin } from './history-generation-origin.js';
import { couponGenerationPublishingRuntime } from './history-generation-factory.js';
import { generationGoogleWarehouseWriter } from './history-generation-writer.js';
import { couponGenerationDemands } from './history-generation-demands.js';
import { couponGenerationDemandWorker } from './history-generation-demand-worker.js';
import { readGenerationPublisherConfiguration } from './history-generation-worker-options.js';
import type { GenerationClient } from './history-generation-sdk.js';
import { originCouponPublishingRuntime } from '../../screening-origins/coupon-publisher-runtime.js';
const credentialSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.literal('tssgcp2025'),
  client_email: z
    .email()
    .max(254)
    .refine((v) => v === v.toLowerCase() && v.endsWith('.gserviceaccount.com')),
  private_key: z.string().min(32).max(16000),
});
/** Explicit startup only. Bounded reads also cover a file grown after fstat. */
function credentialFile(path: string) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64000)
      throw generationError('KEY_REQUIRED', 503);
    const bytes = Buffer.alloc(64001);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size < 1 || size > 64000) throw generationError('KEY_REQUIRED', 503);
    return credentialSchema.parse(JSON.parse(bytes.subarray(0, size).toString('utf8')) as unknown);
  } finally {
    closeSync(fd);
  }
}
function event(
  requestId: string,
  status: 'disabled' | 'started' | 'stopped' | 'unavailable' | 'startup-failed' | 'shutdown-failed',
  counts?: { claimed: number; prepared: number; unavailable: number },
) {
  process[status.endsWith('failed') ? 'stderr' : 'stdout'].write(
    JSON.stringify({
      module: 'legacy-order-imports',
      resource: 'coupon-history-publisher',
      eventId: 'legacy-order-imports.coupon-history-publisher.' + status,
      eventInstanceId: randomUUID(),
      requestId,
      userId: null,
      timestamp: new Date().toISOString(),
      status,
      ...(counts ? { counts } : {}),
    }) + '\n',
  );
}
/** Runnable command. Importing it starts no work. No CLI identities/credentials
 * accepted. Only explicit configuration can select the independent writer. */
export async function runCouponGenerationWorker(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
) {
  const requestId = randomUUID();
  if (args.length) throw generationError('CONFIGURATION', 503);
  const installation = readGenerationPublisherConfiguration(env);
  if (!installation) {
    event(requestId, 'disabled');
    return;
  }
  const config = readConfig(env);
  if (config.DEMO_MODE || !config.MYSQL_WRITER_URL) throw generationError('CONFIGURATION', 503);
  if (realpathSync(installation.readerKeyFile) === realpathSync(installation.writerKeyFile))
    throw generationError('WRITER_REQUIRED', 503);
  const reader = credentialFile(installation.readerKeyFile),
    writer = credentialFile(installation.writerKeyFile);
  if (
    reader.client_email === writer.client_email ||
    writer.client_email === 'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com'
  )
    throw generationError('WRITER_REQUIRED', 503);
  const nativeWriter = generationGoogleWarehouseWriter({
    contract: generationWriterContract,
    credentials: writer,
    readerIdentity: reader.client_email,
    maxBytes: installation.options.maxBytes,
    timeoutMs: installation.options.timeoutMs,
  });
  const clientFactory = (): GenerationClient => {
    const client = new BigQuery({
      projectId: 'tssgcp2025',
      location: 'asia-south1',
      credentials: { client_email: reader.client_email, private_key: reader.private_key },
      autoRetry: false,
      maxRetries: 0,
    });
    client.timeout = installation.options.timeoutMs;
    return {
      async createQueryJob(input) {
        const [job] = await client.createQueryJob(input);
        return [
          {
            get metadata() {
              return job.metadata;
            },
            cancel: () => job.cancel(),
            getQueryResults: (settings) => job.getQueryResults(settings),
          },
        ] as const;
      },
    };
  };
  const pools: ReturnType<typeof databasePool>[] = [],
    controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined,
    pending: Promise<void> | undefined,
    runtime: ReturnType<typeof couponGenerationPublishingRuntime> | undefined,
    finish: (() => void) | undefined,
    started = false;
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
    const sourcePool =
      installation.newWorkEnabled && installation.origin
        ? databasePool(
            installation.origin.url,
            {
              ...config,
              MYSQL_TLS_CA_FILE: installation.origin.tlsCaFile ?? config.MYSQL_TLS_CA_FILE,
            },
            true,
          )
        : undefined;
    if (sourcePool) pools.push(sourcePool);
    const db = { get: () => drizzle(journalPool) },
      source =
        sourcePool && installation.origin
          ? generationSourceOrigin(() => drizzle(sourcePool), {
              serverUuid: installation.origin.serverUuid,
              sourceSchema: installation.origin.sourceSchema,
            })
          : undefined;
    runtime = couponGenerationPublishingRuntime(installation.options, installation.authority, {
      db,
      origin: source,
      controlHttp: installation.controlHttp,
      writer: nativeWriter,
      newWorkEnabled: () => installation.newWorkEnabled && !controller.signal.aborted,
      worker: installation.worker,
      query: { clientFactory },
    });
    const activeRuntime = runtime,
      originPreparation = originCouponPublishingRuntime(env, {
        db,
        journalKey: installation.authority.journalKey,
        sourceKey: installation.authority.sourceKey,
        publicationKey: installation.authority.publicationKey,
        publisher: activeRuntime.publisher,
        enabled: () => installation.newWorkEnabled && !controller.signal.aborted,
      }),
      demands = couponGenerationDemands(db, installation.authority),
      preparation = couponGenerationDemandWorker(
        demands,
        activeRuntime.publisher,
        () => installation.newWorkEnabled && !controller.signal.aborted,
      );
    const tick = async () => {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(installation.worker.deadlineMs),
      ]);
      try {
        if (!signal.aborted) {
          const originPrepared = await originPreparation?.drain(signal);
          if (originPrepared?.unavailable) event(requestId, 'unavailable', originPrepared);
          const prepared = await preparation.drain(signal, 1);
          if (prepared.unavailable) event(requestId, 'unavailable', prepared);
        }
      } catch {
        if (!controller.signal.aborted) event(requestId, 'unavailable');
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            pending = tick();
          }, installation.worker.intervalMs);
      }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    started = true;
    event(requestId, 'started');
    activeRuntime.worker.start();
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
      await runtime?.worker.stop();
      await Promise.all(pools.map((pool) => pool.end()));
      if (started) event(requestId, 'stopped');
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
    await runCouponGenerationWorker();
  } catch {
    event(randomUUID(), 'startup-failed');
    process.exitCode = 1;
  }
}
