import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { counterGenerationContract } from './counter-generation-contracts.js';
import { counterError } from './contracts.js';
import { readNativeHeadMetadataOptions } from '../../screening-origins/native-head-metadata.js';
const file = z.string().min(1).max(4096).refine(isAbsolute),
  optionalFile = z.preprocess((value) => (value === '' ? undefined : value), file.optional()),
  key = z.string().regex(/^[!-~]{32,4096}$/),
  native = z
    .string()
    .url()
    .refine((value) => {
      try {
        const u = new URL(value);
        return (
          u.protocol === 'mysql:' &&
          !u.search &&
          !u.hash &&
          !!u.username &&
          /^\/[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(u.pathname)
        );
      } catch {
        return false;
      }
    }),
  table = z.string().regex(/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]*$/);
export function readCounterGenerationOptions(env: NodeJS.ProcessEnv = process.env) {
  if (!env.POS_SCREENING_COUNTER_GENERATION_CONTRACT) return undefined;
  if (env.DEMO_MODE !== undefined && env.DEMO_MODE !== 'false')
    throw counterError('GENERATION_CONFIGURATION');
  const v = z
    .object({
      POS_SCREENING_COUNTER_GENERATION_CONTRACT: z.literal(counterGenerationContract),
      POS_SCREENING_COUNTER_GENERATION_SOURCE_URL: native,
      POS_SCREENING_COUNTER_GENERATION_PROJECTION_URL: native,
      POS_SCREENING_COUNTER_GENERATION_SOURCE_SERVER_UUID: z.uuid(),
      POS_SCREENING_COUNTER_GENERATION_SOURCE_SCHEMA: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      POS_SCREENING_COUNTER_GENERATION_SOURCE_KEY: key,
      POS_SCREENING_COUNTER_PUBLICATION_KEY: key,
      POS_SCREENING_COUNTER_GENERATION_JOURNAL_KEY: key,
      POS_SCREENING_COUNTER_GENERATION_READER_KEY_FILE: file,
      POS_SCREENING_COUNTER_GENERATION_WRITER_KEY_FILE: file,
      POS_SCREENING_COUNTER_GENERATION_SOURCE_TLS_CA_FILE: optionalFile,
      POS_SCREENING_COUNTER_GENERATION_PROJECTION_TLS_CA_FILE: optionalFile,
      BQ_SCREENING_COUNTER_PUBLICATIONS_VIEW: table,
      BQ_SCREENING_COUNTER_ROWS_VIEW: table,
      POS_SCREENING_COUNTER_GENERATION_NEW_WORK_ENABLED: z.enum(['true', 'false']).default('false'),
      POS_SCREENING_COUNTER_GENERATION_MAX_BYTES: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000000000)
        .default(50000000),
      POS_SCREENING_COUNTER_GENERATION_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(100)
        .max(10000)
        .default(8000),
      POS_SCREENING_COUNTER_GENERATION_DISCOVERY_BATCH_SIZE: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20),
      POS_SCREENING_COUNTER_GENERATION_DISCOVERY_INTERVAL_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .default(5000),
      POS_SCREENING_COUNTER_GENERATION_MAX_DISCOVERY: z.coerce
        .number()
        .int()
        .min(2)
        .max(10)
        .default(2),
      POS_SCREENING_COUNTER_GENERATION_INTERVAL_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .default(5000),
    })
    .safeParse(env);
  if (!v.success) throw counterError('GENERATION_CONFIGURATION');
  const p = v.data,
    source = new URL(p.POS_SCREENING_COUNTER_GENERATION_SOURCE_URL),
    projection = new URL(p.POS_SCREENING_COUNTER_GENERATION_PROJECTION_URL),
    metadata = readNativeHeadMetadataOptions(env);
  if (
    decodeURIComponent(source.username) === decodeURIComponent(projection.username) ||
    p.POS_SCREENING_COUNTER_GENERATION_READER_KEY_FILE ===
      p.POS_SCREENING_COUNTER_GENERATION_WRITER_KEY_FILE ||
    new Set([
      p.POS_SCREENING_COUNTER_GENERATION_SOURCE_KEY,
      p.POS_SCREENING_COUNTER_PUBLICATION_KEY,
      p.POS_SCREENING_COUNTER_GENERATION_JOURNAL_KEY,
    ]).size !== 3 ||
    decodeURIComponent(source.pathname.slice(1)) !==
      p.POS_SCREENING_COUNTER_GENERATION_SOURCE_SCHEMA ||
    source.host !== projection.host ||
    source.pathname !== projection.pathname ||
    !metadata.publisherGrantee ||
    !metadata.counterDefiner ||
    decodeURIComponent(projection.username) !== metadata.publisherGrantee.split('@')[0]
  )
    throw counterError('GENERATION_CONFIGURATION');
  return {
    contract: counterGenerationContract,
    sourceUrl: p.POS_SCREENING_COUNTER_GENERATION_SOURCE_URL,
    projectionUrl: p.POS_SCREENING_COUNTER_GENERATION_PROJECTION_URL,
    sourceTlsCaFile: p.POS_SCREENING_COUNTER_GENERATION_SOURCE_TLS_CA_FILE,
    projectionTlsCaFile: p.POS_SCREENING_COUNTER_GENERATION_PROJECTION_TLS_CA_FILE,
    serverUuid: p.POS_SCREENING_COUNTER_GENERATION_SOURCE_SERVER_UUID,
    sourceSchema: p.POS_SCREENING_COUNTER_GENERATION_SOURCE_SCHEMA,
    sourceKey: p.POS_SCREENING_COUNTER_GENERATION_SOURCE_KEY,
    publicationKey: p.POS_SCREENING_COUNTER_PUBLICATION_KEY,
    journalKey: p.POS_SCREENING_COUNTER_GENERATION_JOURNAL_KEY,
    readerKeyFile: p.POS_SCREENING_COUNTER_GENERATION_READER_KEY_FILE,
    writerKeyFile: p.POS_SCREENING_COUNTER_GENERATION_WRITER_KEY_FILE,
    publications: p.BQ_SCREENING_COUNTER_PUBLICATIONS_VIEW,
    rows: p.BQ_SCREENING_COUNTER_ROWS_VIEW,
    newWorkEnabled: p.POS_SCREENING_COUNTER_GENERATION_NEW_WORK_ENABLED === 'true',
    maxBytes: p.POS_SCREENING_COUNTER_GENERATION_MAX_BYTES,
    timeoutMs: p.POS_SCREENING_COUNTER_GENERATION_TIMEOUT_MS,
    intervalMs: p.POS_SCREENING_COUNTER_GENERATION_INTERVAL_MS,
    headMetadata: metadata,
    discoveryBatchSize: p.POS_SCREENING_COUNTER_GENERATION_DISCOVERY_BATCH_SIZE,
    discoveryIntervalMs: p.POS_SCREENING_COUNTER_GENERATION_DISCOVERY_INTERVAL_MS,
    maxDiscovery: p.POS_SCREENING_COUNTER_GENERATION_MAX_DISCOVERY,
  };
}
export type CounterGenerationOptions = NonNullable<ReturnType<typeof readCounterGenerationOptions>>;
