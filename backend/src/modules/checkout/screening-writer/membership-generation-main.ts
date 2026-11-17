import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { drizzle } from 'drizzle-orm/mysql2';
import { z } from 'zod';
import { readConfig } from '../../../config.js';
import { databasePool, type Databases } from '../../../db/pools.js';
import { csvMembershipHistorySdk } from '../../legacy-order-imports/membership-profile/bigquery.js';
import {
  nativeMembershipGenerationPublisher,
  warehouseMembershipGenerationReader,
} from './membership-history-publication.js';
import { publicMembershipHistoryError } from './membership-history.js';
import {
  publicMembershipGenerationJournal,
  publicMembershipGenerationPublisher,
} from './membership-generation.js';
import { readPublicMembershipPublisherConfiguration } from './membership-generation-options.js';
import {
  publicMembershipGenerationWriter,
  membershipGenerationWriterContract,
} from './membership-generation-writer.js';

function event(
  requestId: string,
  status: 'disabled' | 'started' | 'unavailable' | 'stopped' | 'startup-failed' | 'shutdown-failed',
) {
  try {
    process[status.endsWith('failed') ? 'stderr' : 'stdout'].write(
      JSON.stringify({
        module: 'public-screening',
        resource: 'membership-history-publisher',
        eventId: 'public-screening.membership-history-publisher.' + status,
        eventInstanceId: randomUUID(),
        requestId,
        userId: null,
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
  } catch {
    /* Logging cannot change publication state. */
  }
}
/** Actual supervisor entry. The worker is separate publication infrastructure,
 * not an application historical reader or a source transaction callback. */
export async function runPublicMembershipGenerationWorker(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = process.argv.slice(2),
) {
  const requestId = randomUUID();
  if (args.length) throw publicMembershipHistoryError();
  const installation = readPublicMembershipPublisherConfiguration(env);
  if (!installation) {
    event(requestId, 'disabled');
    return;
  }
  const config = readConfig(env),
    { value: v, options, authority, memberIds } = installation;
  if (config.DEMO_MODE || !config.MYSQL_WRITER_URL) throw publicMembershipHistoryError();
  // Paths are inspected only for identity. Credential contents are consumed
  // exclusively by Google's SDK, never manually read/copied/logged here.
  if (
    realpathSync(v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_READER_KEY_FILE) ===
    realpathSync(v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_WRITER_KEY_FILE)
  )
    throw publicMembershipHistoryError();
  const reader = new BigQuery({
    projectId: 'tssgcp2025',
    location: 'asia-south1',
    keyFilename: v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_READER_KEY_FILE,
    autoRetry: false,
    maxRetries: 0,
  });
  const writer = new BigQuery({
    projectId: 'tssgcp2025',
    location: 'asia-south1',
    keyFilename: v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_WRITER_KEY_FILE,
    autoRetry: false,
    maxRetries: 0,
  });
  reader.timeout = writer.timeout = options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS;
  const [readCredentials, writeCredentials] = await Promise.all([
    reader.authClient.getCredentials(),
    writer.authClient.getCredentials(),
  ]);
  const identity = z
    .email()
    .max(254)
    .refine((email) => email === email.toLowerCase() && email.endsWith('.gserviceaccount.com'));
  const readerIdentity = identity.parse(readCredentials.client_email),
    writerIdentity = identity.parse(writeCredentials.client_email);
  if (
    readerIdentity === writerIdentity ||
    writerIdentity === 'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com'
  )
    throw publicMembershipHistoryError();
  const publishing = publicMembershipGenerationWriter({
    contract: membershipGenerationWriterContract,
    table: v.BQ_PUBLIC_SCREENING_MEMBERSHIP_PUBLICATIONS_TABLE,
    sourceKey: authority.sourceKey,
    publicationKey: authority.publicationKey,
    writerIdentity,
    readerIdentity,
    maximumBytes: options.CSV_MEMBERSHIP_MAX_BYTES_BILLED,
    timeoutMs: options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS,
    client: writer,
  });
  const pools: ReturnType<typeof databasePool>[] = [],
    stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined,
    active: Promise<void> | undefined,
    finish: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shutdown = () => {
    stop.abort();
    if (timer) clearTimeout(timer);
    finish?.();
  };
  try {
    const journalPool = databasePool(config.MYSQL_WRITER_URL, config);
    pools.push(journalPool);
    const db = { get: () => drizzle(journalPool) },
      journal = publicMembershipGenerationJournal(db, authority.journalKey);
    const sourcePool =
      installation.newWork && v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_URL
        ? databasePool(
            v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_URL,
            {
              ...config,
              MYSQL_TLS_CA_FILE:
                v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_TLS_CA_FILE ??
                config.MYSQL_TLS_CA_FILE,
            },
            true,
          )
        : undefined;
    if (sourcePool) pools.push(sourcePool);
    const source = sourcePool
      ? nativeMembershipGenerationPublisher(
          { get: () => drizzle(sourcePool), close: async () => undefined } satisfies Databases,
          {
            contract: 'pos-membership-history-native-publication-v1',
            sourceSchema: v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_SCHEMA!,
            sourceServerUuid: v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_SERVER_UUID!,
            triggerDefiner: v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_TRIGGER_DEFINER!,
            sourceTimeZone: options.CSV_MEMBERSHIP_SOURCE_TIMEZONE!,
            timeoutMs: options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS,
            maxOrders: options.CSV_MEMBERSHIP_MAX_ORDERS,
            maxLines: options.CSV_MEMBERSHIP_MAX_LINES,
          },
          { sourceKey: authority.sourceKey, memberIds },
        )
      : {
          async capture(): Promise<never> {
            throw publicMembershipHistoryError();
          },
        };
    // Fixed SELECT/WITH-only guarded SDK. This private port is never exposed to
    // caller SQL; the producer builds every statement from validated views.
    const query = csvMembershipHistorySdk(
      options,
      () => reader,
      (statement) => statement,
    );
    const warehouse = warehouseMembershipGenerationReader(options, { query, unmaterialized: true });
    const publisher = publicMembershipGenerationPublisher(
      { ...authority, memberIds },
      {
        source,
        journal,
        warehouse,
        writer: publishing,
        enabled: () => installation.newWork && !stop.signal.aborted,
      },
    );
    const tick = async () => {
      try {
        const rows = await journal.pending(1);
        for (const row of rows) {
          if (stop.signal.aborted) break;
          try {
            await publisher.advance(
              row.id,
              AbortSignal.any([stop.signal, AbortSignal.timeout(20000)]),
            );
          } catch {
            if (!stop.signal.aborted) event(requestId, 'unavailable');
          }
        }
      } catch {
        if (!stop.signal.aborted) event(requestId, 'unavailable');
      } finally {
        if (!stop.signal.aborted)
          timer = setTimeout(() => {
            active = tick();
          }, v.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_INTERVAL_MS);
      }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    event(requestId, 'started');
    active = tick();
    await stopped;
  } finally {
    shutdown();
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    try {
      await active;
      await Promise.all(pools.map((pool) => pool.end()));
      event(requestId, 'stopped');
    } catch {
      event(requestId, 'shutdown-failed');
      process.exitCode = 1;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runPublicMembershipGenerationWorker();
  } catch {
    event(randomUUID(), 'startup-failed');
    process.exitCode = 1;
  }
}
