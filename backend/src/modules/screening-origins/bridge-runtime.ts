import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { BigQuery } from '@google-cloud/bigquery';
import { drizzle } from 'drizzle-orm/mysql2';
import { z } from 'zod';
import { databasePool } from '../../db/pools.js';
import { originError } from './contracts.js';
import { createOriginHistoryBridge, type OriginHistoryBridgeEvent } from './bridge.js';
import { originHistoryRuntime, readOriginHistoryOptions } from './history.js';
import { originHistoryDemands } from './history-generation-demand.js';
import { boundedWarehouseSelect, type SelectClient } from '../warehouse/bounded-select.js';
import { originMembershipRuntime } from './membership-runtime.js';
import { originCouponRuntime } from './coupon-runtime.js';
import {
  publicMembershipGenerationJournal,
  membershipGenerationDemandContract,
} from '../checkout/screening-writer/membership-generation.js';
import { originCouponDemandContract, originCouponDemandJournal } from './coupon-demands.js';

const contract = 'pos-screening-origin-history-bridge-v1';
const key = z.string().regex(/^[!-~]{32,4096}$/);
const optional = (value: string | undefined) => value || undefined;
const flag = z.enum(['true', 'false']).default('false');
const path = z.string().max(4096).refine(isAbsolute);

/** Disabled installation does not inspect credentials or open any resource. */
export function readOriginHistoryBridgeConfiguration(env: NodeJS.ProcessEnv) {
  if (!env.POS_SCREENING_ORIGIN_HISTORY_BRIDGE_CONTRACT) return undefined;
  try {
    const value = z
      .object({
        selected: z.literal(contract),
        demo: flag,
        host: z
          .string()
          .refine((value) => value === 'localhost' || isIP(value) !== 0)
          .default('127.0.0.1'),
        port: z.coerce.number().int().min(1).max(65535).default(4424),
        concurrency: z.coerce.number().int().min(1).max(32).default(8),
        sourceKey: key,
        readerKeyFile: path,
        demands: z.literal('pos-screening-origin-history-demands-v1').optional(),
        journalKey: key.optional(),
        journalUrl: z.string().max(16384).optional(),
        tlsCaFile: path.optional(),
        poolSize: z.coerce.number().int().min(1).max(16).default(4),
        maxBytes: z.coerce.number().int().min(1).max(1000000000).default(50000000),
      })
      .parse({
        selected: env.POS_SCREENING_ORIGIN_HISTORY_BRIDGE_CONTRACT,
        demo: optional(env.DEMO_MODE),
        host: optional(env.POS_SCREENING_ORIGIN_HISTORY_BRIDGE_HOST),
        port: optional(env.POS_SCREENING_ORIGIN_HISTORY_BRIDGE_PORT),
        concurrency: optional(env.POS_SCREENING_ORIGIN_HISTORY_BRIDGE_CONCURRENCY),
        sourceKey: env.POS_SCREENING_ORIGIN_PROOF_KEY,
        readerKeyFile: env.POS_SCREENING_ORIGIN_HISTORY_READER_KEY_FILE,
        demands: optional(env.POS_SCREENING_ORIGIN_HISTORY_DEMAND_CONTRACT),
        journalKey: optional(env.POS_SCREENING_ORIGIN_HISTORY_JOURNAL_KEY),
        journalUrl: optional(env.POS_SCREENING_ORIGIN_HISTORY_JOURNAL_URL),
        tlsCaFile: optional(env.POS_SCREENING_ORIGIN_HISTORY_JOURNAL_TLS_CA_FILE),
        poolSize: optional(env.POS_SCREENING_ORIGIN_HISTORY_JOURNAL_POOL_SIZE),
        maxBytes: optional(env.POS_SCREENING_ORIGIN_HISTORY_MAX_BYTES),
      });
    const options = readOriginHistoryOptions(env);
    if (
      value.demo === 'true' ||
      !options.contract ||
      !options.publicationKey ||
      !options.countsView ||
      !options.publicationsView ||
      options.countsView === options.publicationsView
    )
      throw originError();
    const keys = [value.sourceKey, options.publicationKey];
    const memberDemands = env.POS_SCREENING_ORIGIN_MEMBERSHIP_HISTORY_CONTRACT
      ? env.PUBLIC_SCREENING_MEMBERSHIP_DEMAND_CONTRACT
      : undefined;
    const couponDemands = env.POS_SCREENING_ORIGIN_COUPON_HISTORY_CONTRACT
      ? env.POS_SCREENING_ORIGIN_COUPON_DEMAND_CONTRACT
      : undefined;
    if (memberDemands && memberDemands !== membershipGenerationDemandContract) throw originError();
    if (couponDemands && couponDemands !== originCouponDemandContract) throw originError();
    if (value.demands || memberDemands || couponDemands) {
      if ((value.demands && !value.journalKey) || !value.journalUrl) throw originError();
      if (value.demands) keys.push(key.parse(value.journalKey));
      const url = new URL(value.journalUrl);
      if (
        url.protocol !== 'mysql:' ||
        !url.hostname ||
        !url.username ||
        !url.password ||
        !/^\/[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(url.pathname) ||
        url.search ||
        url.hash
      )
        throw originError();
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
    }
    if (memberDemands) {
      const memberJournalKey = key.parse(env.PUBLIC_SCREENING_MEMBERSHIP_GENERATION_JOURNAL_KEY);
      if (
        [
          env.TSS_POS_LEGACY_IMPORT_PROOF_KEY,
          env.PUBLIC_SCREENING_MEMBERSHIP_PUBLICATION_KEY,
          env.PUBLIC_SCREENING_MEMBERSHIP_HISTORY_KEY,
        ].includes(memberJournalKey)
      )
        throw originError();
      keys.push(memberJournalKey);
    }
    if (couponDemands) {
      const couponJournalKey = key.parse(env.CSV_COUPON_GENERATION_JOURNAL_KEY);
      if (
        [
          env.TSS_POS_LEGACY_IMPORT_PROOF_KEY,
          env.CSV_COUPON_PUBLICATION_KEY,
          env.CSV_COUPON_HISTORY_KEY,
        ].includes(couponJournalKey)
      )
        throw originError();
      keys.push(couponJournalKey);
    }
    if (new Set(keys).size !== keys.length) throw originError();
    return {
      ...value,
      options,
      memberDemands: Boolean(memberDemands),
      couponDemands: Boolean(couponDemands),
    };
  } catch {
    // Never surface validation issues, URLs, paths or secret values.
    throw originError('SCREENING_ORIGIN_HISTORY_CONFIGURATION');
  }
}

export function originHistoryBridgeLifecycle(
  action: 'disabled' | 'started' | 'stopped' | 'startup-failed' | 'shutdown-failed',
  requestId: string,
) {
  return {
    module: 'screening-origins',
    resource: 'history-bridge-runtime',
    eventId: `screening-origins.history-bridge-runtime.${action}`,
    eventInstanceId: randomUUID(),
    requestId,
    userId: null,
    timestamp: new Date().toISOString(),
  };
}

/** One private HMAC route and liveness only. No session middleware, source
 * capture, publication writer, public application or financial adapter. */
export async function buildOriginHistoryBridgeRuntime(
  env: NodeJS.ProcessEnv = process.env,
  observe?: (event: OriginHistoryBridgeEvent) => void,
) {
  const selected = readOriginHistoryBridgeConfiguration(env);
  if (!selected) return { enabled: false, stop: async () => {} } as const;
  let pool: ReturnType<typeof databasePool> | undefined;
  let app: Awaited<ReturnType<typeof createOriginHistoryBridge>> | undefined;
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      try {
        await app?.close();
      } finally {
        await pool?.end();
      }
    })());
  try {
    const sdk = new BigQuery({
      projectId: 'tssgcp2025',
      location: 'asia-south1',
      keyFilename: selected.readerKeyFile,
      autoRetry: false,
      maxRetries: 0,
    });
    sdk.timeout = selected.options.timeoutMs ?? 8000;
    const credentials = await sdk.authClient.getCredentials();
    if (credentials.client_email !== 'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com')
      throw originError('SCREENING_ORIGIN_HISTORY_READER_REQUIRED');
    const client: SelectClient = {
      async createQueryJob(query) {
        const [job] = await sdk.createQueryJob(query);
        return [
          {
            get metadata() {
              return job.metadata;
            },
            cancel: () => job.cancel(),
            async getQueryResults(settings) {
              const [rows, next, response] = await job.getQueryResults(settings);
              return [rows, next, response] as const;
            },
          },
        ] as const;
      },
    };
    const journal = () => {
      if (!pool) {
        pool = databasePool(selected.journalUrl!, {
          MYSQL_ALLOW_LOCAL_PLAINTEXT: false,
          MYSQL_POOL_SIZE: selected.poolSize,
          MYSQL_TLS_CA_FILE: selected.tlsCaFile,
        });
      }
      const journalPool = pool;
      return { get: () => drizzle(journalPool) };
    };
    const demand = selected.demands
      ? (() => {
          return originHistoryDemands(journal(), {
            journalKey: selected.journalKey!,
            sourceKey: selected.sourceKey,
          });
        })()
      : undefined;
    const membershipHistory = originMembershipRuntime(env, selected.sourceKey, {
      select: boundedWarehouseSelect(
        {
          maxBytes: selected.maxBytes,
          timeoutMs: selected.options.timeoutMs ?? 8000,
          maxDocumentBytes: 2000000,
          resource: 'origin-membership-history',
        },
        () => client,
      ),
      ...(selected.memberDemands
        ? {
            demands: publicMembershipGenerationJournal(
              journal(),
              env.PUBLIC_SCREENING_MEMBERSHIP_GENERATION_JOURNAL_KEY!,
            ),
          }
        : {}),
    });
    const couponHistory = originCouponRuntime(
      env,
      {
        originKey: selected.sourceKey,
        sourceKey: env.TSS_POS_LEGACY_IMPORT_PROOF_KEY ?? '',
        publicationKey: env.CSV_COUPON_PUBLICATION_KEY ?? '',
      },
      {
        clientFactory: () => client,
        ...(selected.couponDemands
          ? {
              demand: originCouponDemandJournal(journal(), {
                journalKey: env.CSV_COUPON_GENERATION_JOURNAL_KEY!,
                originKey: selected.sourceKey,
              }),
            }
          : {}),
      },
    );
    const history = originHistoryRuntime(
      { BIGQUERY_MAX_BYTES_BILLED: selected.maxBytes },
      env,
      { sourceKey: selected.sourceKey },
      {
        select: boundedWarehouseSelect(
          {
            maxBytes: selected.maxBytes,
            timeoutMs: selected.options.timeoutMs ?? 8000,
            maxDocumentBytes: 262144,
            resource: 'origin-first-order-history',
          },
          () => client,
        ),
        ...(demand ? { demand } : {}),
      },
    );
    if (!history) throw originError('SCREENING_ORIGIN_HISTORY_CONFIGURATION');
    app = await createOriginHistoryBridge({
      sourceKey: selected.sourceKey,
      history,
      ...(membershipHistory ? { membershipHistory } : {}),
      ...(couponHistory ? { couponHistory } : {}),
      observe,
      maxConcurrentRequests: selected.concurrency,
    });
    app.get(
      '/health/live',
      {
        config: {
          authentication: 'service',
          trace: {
            module: 'screening-origins',
            resource: 'history-bridge-runtime',
            action: 'read',
          },
        },
      },
      async () => ({ status: 'ok' }),
    );
    const server = app;
    return {
      enabled: true,
      app: server,
      listen: () => server.listen({ host: selected.host, port: selected.port }),
      stop,
    } as const;
  } catch {
    await stop().catch(() => undefined);
    throw originError('SCREENING_ORIGIN_HISTORY_CONFIGURATION');
  }
}
