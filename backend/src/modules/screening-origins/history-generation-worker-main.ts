import { randomUUID } from 'node:crypto';
import { openSync, readSync, fstatSync, closeSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import { originError } from './contracts.js';
import { originHistoryKeys } from './history-contracts.js';
import { originHistoryJournal } from './history-generation-demand.js';
import { originHistorySource } from './history-generation-source.js';
import {
  originHistoryCandidate,
  originHistoryWarehouseOptionsSchema,
  originHistoryWriter,
} from './history-generation-warehouse.js';
import { originHistoryGenerationPublisher } from './history-generation-worker.js';
import { boundedWarehouseSelect, type SelectClient } from '../warehouse/bounded-select.js';

const secret = z.string().regex(/^[!-~]{32,4096}$/),
  file = z.string().max(4096).refine(isAbsolute),
  credential = z.object({
    type: z.literal('service_account'),
    project_id: z.literal('tssgcp2025'),
    client_email: z.email().max(254),
    private_key: z.string().min(32).max(16000),
  });
function jsonFile(path: string): unknown {
  file.parse(path);
  const descriptor = openSync(path, 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64000) throw originError();
    const bytes = Buffer.alloc(64001);
    let length = 0;
    while (length < bytes.length) {
      const size = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!size) break;
      length += size;
    }
    if (length < 1 || length > 64000) throw originError();
    return JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown;
  } finally {
    closeSync(descriptor);
  }
}
function settings(env: NodeJS.ProcessEnv) {
  if (
    !env.POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_CONTRACT &&
    !env.POS_SCREENING_ORIGIN_HISTORY_JOURNAL_KEY
  )
    return undefined;
  if (env.DEMO_MODE === 'true' || (env.DEMO_MODE && !['true', 'false'].includes(env.DEMO_MODE)))
    throw originError('SCREENING_ORIGIN_HISTORY_PUBLISHER_CONFIGURATION');
  const selected = env.POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_CONTRACT;
  if (selected && selected !== 'pos-screening-origin-history-publisher-v1')
    throw originError('SCREENING_ORIGIN_HISTORY_PUBLISHER_CONFIGURATION');
  const enabled =
    selected === 'pos-screening-origin-history-publisher-v1' &&
    env.POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_ENABLED === 'true';
  if (
    env.POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_ENABLED &&
    !['true', 'false'].includes(env.POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_ENABLED)
  )
    throw originError();
  const value = z
    .object({
      journalKey: secret,
      journalUrl: z.string().max(16384),
      journalCa: file.optional(),
      writerFile: file,
      readerFile: file.optional(),
      captureKey: secret.optional(),
      publicationKey: secret.optional(),
      sourceFile: file.optional(),
      python: file.optional(),
      module: file.optional(),
      definer: z.string().max(320).optional(),
      auditDefiner: z.string().max(320).optional(),
      membershipDefiner: z.string().max(320).optional(),
      couponDefiner: z.string().max(320).optional(),
      counterDefiner: z.string().max(320).optional(),
      counterPublisher: z.string().max(320).optional(),
      administrators: z.string().max(16000).default('[]'),
      intervalMs: z.coerce.number().int().min(1000).max(60000).default(5000),
      deadlineMs: z.coerce.number().int().min(1000).max(60000).default(25000),
      limit: z.coerce.number().int().min(1).max(100).default(10),
      once: z.enum(['true', 'false']).default('false'),
    })
    .parse({
      journalKey: env.POS_SCREENING_ORIGIN_HISTORY_JOURNAL_KEY,
      journalUrl: env.POS_SCREENING_ORIGIN_HISTORY_JOURNAL_URL,
      journalCa: env.POS_SCREENING_ORIGIN_HISTORY_JOURNAL_TLS_CA_FILE || undefined,
      writerFile: env.POS_SCREENING_ORIGIN_HISTORY_WRITER_KEY_FILE,
      readerFile: env.POS_SCREENING_ORIGIN_HISTORY_READER_KEY_FILE || undefined,
      captureKey: env.POS_SCREENING_ORIGIN_HISTORY_CAPTURE_KEY || undefined,
      publicationKey: env.POS_SCREENING_ORIGIN_HISTORY_PUBLICATION_KEY || undefined,
      sourceFile: env.POS_SCREENING_ORIGIN_HISTORY_SOURCE_KEY_FILE || undefined,
      python: env.POS_SCREENING_ORIGIN_HISTORY_SOURCE_PYTHON || undefined,
      module: env.POS_SCREENING_ORIGIN_HISTORY_SOURCE_MODULE || undefined,
      definer: env.POS_SCREENING_ORIGIN_HISTORY_DEFINER || undefined,
      auditDefiner: env.POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER || undefined,
      membershipDefiner: env.POS_MEMBERSHIP_HISTORY_TRIGGER_DEFINER || undefined,
      couponDefiner: env.POS_COUPON_HISTORY_DEFINER || undefined,
      counterDefiner: env.POS_SCREENING_COUNTER_TRIGGER_DEFINER || undefined,
      counterPublisher: env.POS_SCREENING_COUNTER_PUBLISHER_GRANTEE || undefined,
      administrators: env.POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES || '[]',
      intervalMs: env.POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_INTERVAL_MS || undefined,
      deadlineMs: env.POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_DEADLINE_MS || undefined,
      limit: env.POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_BATCH || undefined,
      once: env.POS_SCREENING_ORIGIN_HISTORY_PUBLISHER_ONCE || undefined,
    });
  originHistoryKeys(
    value.journalKey,
    ...[value.captureKey, value.publicationKey].filter((key): key is string => Boolean(key)),
  );
  if (
    env.POS_SCREENING_ORIGIN_PROOF_KEY &&
    [value.journalKey, value.captureKey, value.publicationKey].includes(
      env.POS_SCREENING_ORIGIN_PROOF_KEY,
    )
  )
    throw originError();
  const options = enabled
    ? originHistoryWarehouseOptionsSchema.parse({
        orders: env.BQ_SCREENING_ORIGIN_HISTORY_ORDERS_TABLE,
        manifests: env.BQ_SCREENING_ORIGIN_HISTORY_MANIFESTS_TABLE,
        counts: env.BQ_SCREENING_ORIGIN_HISTORY_COUNTS_TABLE,
        publications: env.BQ_SCREENING_ORIGIN_HISTORY_PUBLICATIONS_TABLE,
        maxBytes: Number(env.POS_SCREENING_ORIGIN_HISTORY_MAX_BYTES || 50000000),
        timeoutMs: Number(env.POS_SCREENING_ORIGIN_HISTORY_TIMEOUT_MS || 8000),
      })
    : undefined;
  if (
    enabled &&
    (!value.readerFile ||
      !value.captureKey ||
      !value.publicationKey ||
      !value.sourceFile ||
      !value.python ||
      !value.module ||
      !value.definer ||
      !value.auditDefiner)
  )
    throw originError();
  return { ...value, enabled, options };
}
function event(
  requestId: string,
  action: string,
  summary?: { read: number; advanced: number; unavailable: number },
) {
  process.stdout.write(
    JSON.stringify({
      module: 'screening-origins',
      resource: 'history-generation-publisher',
      eventId: 'screening-origins.history-generation-publisher.' + action,
      eventInstanceId: randomUUID(),
      requestId,
      userId: null,
      timestamp: new Date().toISOString(),
      ...(summary ? { summary } : {}),
    }) + '\n',
  );
}
/** Explicit command, no constructor/listener side effects and no ADC writer.
 * Source, warehouse and journal are separately credentialed capabilities. */
export async function runOriginHistoryPublisher(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
) {
  const requestId = randomUUID();
  let pool: ReturnType<typeof mysql.createPool> | undefined;
  let shutdownDeadline: ReturnType<typeof setTimeout> | undefined;
  let stop: () => void = () => undefined;
  try {
    if (args.length) throw originError();
    const config = settings(env);
    if (!config) {
      event(requestId, 'disabled');
      return;
    }
    const writer = credential.parse(jsonFile(config.writerFile));
    if (
      writer.client_email.toLowerCase() ===
      'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com'
    )
      throw originError('SCREENING_ORIGIN_HISTORY_WRITER_REQUIRED');
    const reader = config.enabled ? credential.parse(jsonFile(config.readerFile!)) : undefined;
    if (
      reader &&
      (reader.client_email !== 'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com' ||
        reader.client_email.toLowerCase() === writer.client_email.toLowerCase() ||
        realpathSync(config.readerFile!) === realpathSync(config.writerFile))
    )
      throw originError();
    const journalUrl = new URL(config.journalUrl);
    if (
      journalUrl.protocol !== 'mysql:' ||
      !journalUrl.hostname ||
      !journalUrl.username ||
      !journalUrl.password ||
      !/^\/[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(journalUrl.pathname) ||
      journalUrl.search ||
      journalUrl.hash
    )
      throw originError();
    pool = mysql.createPool({
      host: journalUrl.hostname,
      port: Number(journalUrl.port || 3306),
      user: decodeURIComponent(journalUrl.username),
      password: decodeURIComponent(journalUrl.password),
      database: journalUrl.pathname.slice(1),
      ssl: {
        rejectUnauthorized: true,
        ...(config.journalCa ? { ca: readFileSync(config.journalCa) } : {}),
      },
      connectionLimit: 4,
      connectTimeout: 6000,
      queueLimit: 32,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      multipleStatements: false,
      timezone: 'Z',
    });
    pool.pool.on('connection', (connection) => {
      connection.query('SET SESSION innodb_lock_wait_timeout=10', (error) => {
        if (error) connection.destroy();
      });
      connection.query('SET SESSION MAX_EXECUTION_TIME=10000', (error) => {
        if (error) connection.destroy();
      });
    });
    const journalPool = pool,
      journal = originHistoryJournal({ get: () => drizzle(journalPool) }, config.journalKey);
    const sourceConfig = config.enabled
      ? z
          .object({
            url: z.string().max(16384),
            sourceSchema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
            sourceServerUuid: z.uuid(),
            tlsCaFile: file,
          })
          .strict()
          .parse(jsonFile(config.sourceFile!))
      : undefined;
    const source = sourceConfig
      ? originHistorySource({
          python: config.python!,
          modulePath: config.module!,
          sourceUrl: sourceConfig.url,
          caFile: sourceConfig.tlsCaFile,
          sourceSchema: sourceConfig.sourceSchema,
          sourceServerUuid: sourceConfig.sourceServerUuid,
          captureKey: config.captureKey!,
          triggerDefiner: config.definer!,
          auditDefiner: config.auditDefiner!,
          headDefiners: { membership: config.membershipDefiner, coupon: config.couponDefiner,
            counter: config.counterDefiner, counterPublisher: config.counterPublisher },
          administrators: z
            .array(z.string().max(320))
            .max(32)
            .parse(JSON.parse(config.administrators) as unknown),
          timeoutMs: Math.min(config.deadlineMs, 25000),
        })
      : undefined;
    const select =
      reader && config.options
        ? boundedWarehouseSelect(
            {
              maxBytes: config.options.maxBytes,
              timeoutMs: config.options.timeoutMs,
              maxDocumentBytes: 262144,
              resource: 'origin-history-candidate',
            },
            () => {
              const native = new BigQuery({
                projectId: 'tssgcp2025',
                location: 'asia-south1',
                credentials: { client_email: reader.client_email, private_key: reader.private_key },
                autoRetry: false,
                maxRetries: 0,
              });
              native.timeout = config.options!.timeoutMs;
              return {
                async createQueryJob(query) {
                  const [job] = await native.createQueryJob(query);
                  return [
                    {
                      get metadata() {
                        return job.metadata;
                      },
                      cancel: () => job.cancel(),
                      getQueryResults: (options) => job.getQueryResults(options),
                    },
                  ] as const;
                },
              } satisfies SelectClient;
            },
          )
        : undefined;
    const writerPort = originHistoryWriter({
      contract: 'pos-screening-origin-history-warehouse-writer-v1',
      writerIdentity: writer.client_email,
      readerIdentity:
        reader?.client_email ?? 'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com',
      maxBytes: config.options?.maxBytes ?? 50000000,
      timeoutMs: config.options?.timeoutMs ?? 8000,
      clientFactory: () => {
        const native = new BigQuery({
          projectId: 'tssgcp2025',
          location: 'asia-south1',
          credentials: { client_email: writer.client_email, private_key: writer.private_key },
          autoRetry: false,
          maxRetries: 0,
        });
        native.timeout = config.options?.timeoutMs ?? 8000;
        return native;
      },
    });
    const worker = originHistoryGenerationPublisher({
      journal,
      journalKey: config.journalKey,
      captureKey: config.captureKey,
      publicationKey: config.publicationKey,
      options: config.options,
      source,
      candidate:
        select && config.options ? originHistoryCandidate(config.options, select) : undefined,
      writer: writerPort,
      newWorkEnabled: () => config.enabled,
    });
    const controller = new AbortController();
    let wake: (() => void) | undefined;
    stop = () => {
      controller.abort();
      wake?.();
      shutdownDeadline ??= setTimeout(() => {
        event(requestId, 'shutdown-failed');
        process.exit(1);
      }, 40000);
      shutdownDeadline.unref();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    event(requestId, config.enabled ? 'started' : 'recovery-started');
    do {
      try {
        const summary = await worker.drain(
          AbortSignal.any([controller.signal, AbortSignal.timeout(config.deadlineMs)]),
          config.limit,
        );
        event(randomUUID(), 'cycle', summary);
      } catch {
        event(randomUUID(), 'unavailable');
      }
      if (config.once === 'true' || controller.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, config.intervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    } while (!controller.signal.aborted);
    event(requestId, 'stopped');
  } catch {
    event(requestId, 'startup-or-runtime-failed');
    process.exitCode = 1;
  } finally {
    stop();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try {
      await pool?.end().catch(() => {
        event(requestId, 'shutdown-failed');
        process.exitCode = 1;
      });
    } finally {
      if (shutdownDeadline) clearTimeout(shutdownDeadline);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOriginHistoryPublisher();
