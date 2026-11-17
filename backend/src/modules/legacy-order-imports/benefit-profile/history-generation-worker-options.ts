import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { generationError, generationWriterContract } from './history-generation-contracts.js';
import { readGenerationOptions, requireGenerationOptions } from './history-generation-options.js';
import { readGenerationControlHttpOptions } from './history-generation-control-http.js';
import { generationOriginIdentitySchema } from './history-generation-origin.js';
import { generationDemandContract } from './history-generation-demands.js';
import { readGenerationWorkerOptions } from './history-generation-worker.js';
import { couponWarehouseKeys } from './history-warehouse-contracts.js';
const key = z.string().regex(/^[!-~]{32,4096}$/),
  file = z.string().min(1).max(4096).refine(isAbsolute);
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
/** Pure configuration. Disabled workers require no credentials, source URL or
 * existing connection. Enabled recovery does not require new-work selectors. */
export function readGenerationPublisherConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const worker = readGenerationWorkerOptions(env);
  if (!worker.enabled) return undefined;
  const parsed = z
    .object({
      TSS_POS_LEGACY_IMPORT_PROOF_KEY: key,
      CSV_COUPON_PUBLICATION_KEY: key,
      CSV_COUPON_HISTORY_KEY: key,
      CSV_COUPON_GENERATION_JOURNAL_KEY: key,
      CSV_COUPON_GENERATION_READER_KEY_FILE: file,
      CSV_COUPON_GENERATION_WRITER_KEY_FILE: file,
      CSV_COUPON_GENERATION_WRITER_CONTRACT: optional(z.literal(generationWriterContract)),
      CSV_COUPON_GENERATION_DEMAND_CONTRACT: optional(z.literal(generationDemandContract)),
      CSV_COUPON_GENERATION_NEW_WORK_ENABLED: z.preprocess(
        (v) =>
          v === undefined || v === '' ? false : v === 'true' ? true : v === 'false' ? false : v,
        z.boolean(),
      ),
      CSV_COUPON_GENERATION_SOURCE_URL: optional(
        z.url().refine((v) => {
          try {
            const u = new URL(v);
            return (
              u.protocol === 'mysql:' &&
              !u.search &&
              !u.hash &&
              Boolean(u.username) &&
              Boolean(u.pathname.slice(1))
            );
          } catch {
            return false;
          }
        }),
      ),
      CSV_COUPON_GENERATION_SOURCE_SERVER_UUID: optional(z.uuid()),
      CSV_COUPON_GENERATION_SOURCE_SCHEMA: optional(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      ),
      CSV_COUPON_GENERATION_SOURCE_TLS_CA_FILE: optional(file),
    })
    .safeParse(env);
  if (!parsed.success) throw generationError('CONFIGURATION', 503);
  const v = parsed.data,
    options = readGenerationOptions(env),
    controlHttp = readGenerationControlHttpOptions(env);
  const authority = {
    sourceKey: v.TSS_POS_LEGACY_IMPORT_PROOF_KEY,
    publicationKey: v.CSV_COUPON_PUBLICATION_KEY,
    historyKey: v.CSV_COUPON_HISTORY_KEY,
    journalKey: v.CSV_COUPON_GENERATION_JOURNAL_KEY,
  };
  couponWarehouseKeys(...Object.values(authority), ...(controlHttp.key ? [controlHttp.key] : []));
  if (v.CSV_COUPON_GENERATION_READER_KEY_FILE === v.CSV_COUPON_GENERATION_WRITER_KEY_FILE)
    throw generationError('WRITER_REQUIRED', 503);
  const hasOrigin = Boolean(
    v.CSV_COUPON_GENERATION_SOURCE_URL ||
    v.CSV_COUPON_GENERATION_SOURCE_SERVER_UUID ||
    v.CSV_COUPON_GENERATION_SOURCE_SCHEMA,
  );
  let origin:
    { url: string; serverUuid: string; sourceSchema: string; tlsCaFile?: string } | undefined;
  if (hasOrigin) {
    if (
      !v.CSV_COUPON_GENERATION_SOURCE_URL ||
      !v.CSV_COUPON_GENERATION_SOURCE_SERVER_UUID ||
      !v.CSV_COUPON_GENERATION_SOURCE_SCHEMA
    )
      throw generationError('ORIGIN_REQUIRED', 503);
    const identity = generationOriginIdentitySchema.parse({
      serverUuid: v.CSV_COUPON_GENERATION_SOURCE_SERVER_UUID,
      sourceSchema: v.CSV_COUPON_GENERATION_SOURCE_SCHEMA,
    });
    if (
      decodeURIComponent(new URL(v.CSV_COUPON_GENERATION_SOURCE_URL).pathname.slice(1)) !==
      identity.sourceSchema
    )
      throw generationError('ORIGIN_REQUIRED', 503);
    origin = {
      url: v.CSV_COUPON_GENERATION_SOURCE_URL,
      ...identity,
      tlsCaFile: v.CSV_COUPON_GENERATION_SOURCE_TLS_CA_FILE,
    };
  }
  const newWorkEnabled = v.CSV_COUPON_GENERATION_NEW_WORK_ENABLED;
  if (newWorkEnabled) {
    requireGenerationOptions(options, 'read');
    requireGenerationOptions(options, 'candidate');
    if (
      !origin ||
      !options.sourceOrdersByCustomer ||
      !options.sourceOrdersByCoupon ||
      !controlHttp.contract ||
      !controlHttp.url ||
      !controlHttp.key ||
      v.CSV_COUPON_GENERATION_WRITER_CONTRACT !== generationWriterContract ||
      v.CSV_COUPON_GENERATION_DEMAND_CONTRACT !== generationDemandContract
    )
      throw generationError('CONFIGURATION', 503);
  }
  return {
    worker,
    options,
    authority,
    origin,
    controlHttp,
    newWorkEnabled,
    readerKeyFile: v.CSV_COUPON_GENERATION_READER_KEY_FILE,
    writerKeyFile: v.CSV_COUPON_GENERATION_WRITER_KEY_FILE,
  };
}
