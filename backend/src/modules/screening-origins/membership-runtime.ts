import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import {
  readPublicMembershipBigQueryOptions,
  publicMembershipBigQueryContract,
} from '../checkout/screening-writer/membership-history.js';
import { originError } from './contracts.js';
import { originMembershipHistory, originMembershipHistoryContract } from './membership-history.js';

/** Pure opt-in reader factory. Publication tables, predicates and journal are
 * genuine shared generations; no checkout or import capability is invented. */
export function originMembershipRuntime(
  env: NodeJS.ProcessEnv,
  originKey: string,
  dependencies: Parameters<typeof originMembershipHistory>[2] = {},
) {
  if (!env.POS_SCREENING_ORIGIN_MEMBERSHIP_HISTORY_CONTRACT) return undefined;
  try {
    if (
      env.DEMO_MODE === 'true' ||
      env.POS_SCREENING_ORIGIN_MEMBERSHIP_HISTORY_CONTRACT !== originMembershipHistoryContract ||
      env.PUBLIC_SCREENING_MEMBERSHIP_BIGQUERY_CONTRACT !== publicMembershipBigQueryContract
    )
      throw originError();
    const options = readPublicMembershipBigQueryOptions(env);
    if (!options.BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW || !options.CSV_MEMBERSHIP_SOURCE_TIMEZONE)
      throw originError();
    const members = z
      .array(identifier)
      .min(1)
      .max(1000)
      .parse(JSON.parse(env.POS_MEMBERSHIP_PRODUCT_IDS ?? '[]') as unknown);
    return originMembershipHistory(
      {
        view: options.BQ_CSV_MEMBERSHIP_PUBLICATIONS_VIEW,
        maxBytes: options.CSV_MEMBERSHIP_MAX_BYTES_BILLED,
        timeoutMs: options.CSV_MEMBERSHIP_QUERY_TIMEOUT_MS,
        sourceTimeZone: options.CSV_MEMBERSHIP_SOURCE_TIMEZONE,
      },
      {
        originKey,
        captureKey: env.TSS_POS_LEGACY_IMPORT_PROOF_KEY ?? '',
        publicationKey: env.PUBLIC_SCREENING_MEMBERSHIP_PUBLICATION_KEY ?? '',
        memberIds: members,
      },
      dependencies,
    );
  } catch {
    throw originError('SCREENING_ORIGIN_MEMBERSHIP_CONFIGURATION');
  }
}
