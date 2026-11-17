import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import {
  assertMembershipHistoryKeys,
  publicMembershipHistoryError,
  readPublicMembershipBigQueryOptions,
} from './membership-history.js';
import {
  membershipGenerationDemandContract,
  membershipGenerationPublisherContract,
  publicMembershipGenerationJournal,
  type PublicMembershipGenerationDemands,
} from './membership-generation.js';
import { membershipGenerationWriterContract } from './membership-generation-writer.js';

const key = z.string().regex(/^[!-~]{32,4096}$/),
  file = z.string().min(1).max(4096).refine(isAbsolute),
  target = z.string().regex(/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/);
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
function otherPurposeKeys(env: NodeJS.ProcessEnv) {
  return [
    'POS_MEMBERSHIP_PROOF_KEY',
    'TSS_POS_CUSTOMER_CONTEXT_KEY',
    'TSS_POS_PUBLIC_SCREENING_PREPARATION_KEY',
    'TSS_POS_PUBLIC_SCREENING_PUBLICATION_KEY',
    'TSS_POS_PUBLIC_SCREENING_NEGATIVE_KEY',
  ].flatMap((name) => (env[name] ? [key.parse(env[name])] : []));
}
export function configuredPublicMembershipGenerationDemands(
  db: Pick<Databases, 'get'>,
  env: NodeJS.ProcessEnv = process.env,
): PublicMembershipGenerationDemands | undefined {
  if (env.DEMO_MODE === 'true' || !env.PUBLIC_SCREENING_MEMBERSHIP_DEMAND_CONTRACT)
    return undefined;
  try {
    if (env.PUBLIC_SCREENING_MEMBERSHIP_DEMAND_CONTRACT !== membershipGenerationDemandContract)
      throw publicMembershipHistoryError();
    const journalKey = key.parse(env.PUBLIC_SCREENING_MEMBERSHIP_GENERATION_JOURNAL_KEY);
    assertMembershipHistoryKeys(
      journalKey,
      key.parse(env.TSS_POS_LEGACY_IMPORT_PROOF_KEY),
      key.parse(env.PUBLIC_SCREENING_MEMBERSHIP_PUBLICATION_KEY),
      key.parse(env.PUBLIC_SCREENING_MEMBERSHIP_HISTORY_KEY),
      ...otherPurposeKeys(env),
    );
    return publicMembershipGenerationJournal(db, journalKey);
  } catch {
    // New background demand configuration cannot prevent retained sale recovery.
    return {
      async request() {
        throw publicMembershipHistoryError();
      },
    };
  }
}
/** Pure options: default-off/DEMO needs neither keys, files, database nor SDK. */
export function readPublicMembershipPublisherConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.DEMO_MODE === 'true' ||
    [undefined, '', 'false'].includes(env.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_ENABLED)
  )
    return undefined;
  const parsed = z
    .object({
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_ENABLED: z.literal('true'),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_CONTRACT: z.literal(
        membershipGenerationPublisherContract,
      ),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_NEW_WORK_ENABLED: z
        .enum(['true', 'false'])
        .default('false'),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_WRITER_CONTRACT: optional(
        z.literal(membershipGenerationWriterContract),
      ),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_READER_KEY_FILE: file,
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_WRITER_KEY_FILE: file,
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_URL: optional(
        z.url().refine((value) => {
          try {
            const url = new URL(value);
            return (
              url.protocol === 'mysql:' &&
              Boolean(url.username) &&
              Boolean(url.pathname.slice(1)) &&
              !url.search &&
              !url.hash
            );
          } catch {
            return false;
          }
        }),
      ),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_SCHEMA: optional(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      ),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_SERVER_UUID: optional(z.uuid()),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_TLS_CA_FILE: optional(file),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_TRIGGER_DEFINER: optional(
        z.string().regex(/^[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}$/),
      ),
      PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_INTERVAL_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(60000)
        .default(5000),
      BQ_PUBLIC_SCREENING_MEMBERSHIP_PUBLICATIONS_TABLE: target,
      TSS_POS_LEGACY_IMPORT_PROOF_KEY: key,
      PUBLIC_SCREENING_MEMBERSHIP_PUBLICATION_KEY: key,
      PUBLIC_SCREENING_MEMBERSHIP_HISTORY_KEY: key,
      PUBLIC_SCREENING_MEMBERSHIP_GENERATION_JOURNAL_KEY: key,
      POS_MEMBERSHIP_PRODUCT_IDS: z.string().max(32000).default('[]'),
    })
    .safeParse(env);
  if (!parsed.success) throw publicMembershipHistoryError();
  const value = parsed.data,
    newWork = value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_NEW_WORK_ENABLED === 'true';
  let options: ReturnType<typeof readPublicMembershipBigQueryOptions>;
  try {
    options = readPublicMembershipBigQueryOptions(env);
  } catch {
    if (newWork) throw publicMembershipHistoryError();
    options = readPublicMembershipBigQueryOptions({});
  }
  const authority = {
    sourceKey: value.TSS_POS_LEGACY_IMPORT_PROOF_KEY,
    publicationKey: value.PUBLIC_SCREENING_MEMBERSHIP_PUBLICATION_KEY,
    historyKey: value.PUBLIC_SCREENING_MEMBERSHIP_HISTORY_KEY,
    journalKey: value.PUBLIC_SCREENING_MEMBERSHIP_GENERATION_JOURNAL_KEY,
  };
  assertMembershipHistoryKeys(...Object.values(authority), ...otherPurposeKeys(env));
  const memberIds = z
    .array(z.string().regex(/^[1-9]\d{0,18}$/))
    .max(100)
    .parse(JSON.parse(value.POS_MEMBERSHIP_PRODUCT_IDS) as unknown);
  if (
    value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_READER_KEY_FILE ===
    value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_WRITER_KEY_FILE
  )
    throw publicMembershipHistoryError();
  if (
    newWork &&
    (!value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_URL ||
      !value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_SCHEMA ||
      !value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_SERVER_UUID ||
      !value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_TRIGGER_DEFINER ||
      !value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_WRITER_CONTRACT ||
      !options.CSV_MEMBERSHIP_BIGQUERY_CONTRACT ||
      !options.CSV_MEMBERSHIP_SOURCE_TIMEZONE ||
      !options.BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW ||
      !options.BQ_CSV_MEMBERSHIP_ORDERS_VIEW ||
      !options.BQ_CSV_MEMBERSHIP_LINES_VIEW ||
      !memberIds.length)
  )
    throw publicMembershipHistoryError();
  if (
    value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_URL &&
    decodeURIComponent(
      new URL(value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_URL).pathname.slice(1),
    ) !== value.PUBLIC_SCREENING_MEMBERSHIP_PUBLISHER_SOURCE_SCHEMA
  )
    throw publicMembershipHistoryError();
  return { value, options, authority, memberIds, newWork };
}
