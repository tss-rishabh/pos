import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { importFinancialError } from './financial-adapter-crypto.js';
import { sourceOrderPreparationContract } from './source-order-preparation-contracts.js';
import { readCsvMembershipBigQueryOptions } from './membership-profile/bigquery.js';

const optional = <T>(schema: z.ZodType<T>) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const key = z.string().regex(/^[!-~]{32,4096}$/);
export function readSourceOrderPreparationOptions(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z
    .object({
      UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT: optional(
        z.literal(sourceOrderPreparationContract),
      ),
      CSV_MEMBERSHIP_HISTORY_KEY: optional(key),
      CSV_MEMBERSHIP_PUBLICATION_KEY: optional(key),
      CSV_COUPON_HISTORY_KEY: optional(key),
      CSV_COUPON_PUBLICATION_KEY: optional(key),
      CSV_COUPON_GUARD_KEY: optional(key),
      POS_MEMBERSHIP_PROOF_KEY: optional(key),
      POS_MEMBERSHIP_PRODUCT_IDS: z.string().max(32000).default('[]'),
    })
    .safeParse(env);
  if (!parsed.success) throw importFinancialError('ORDER_IMPORT_PREPARATION_CONFIGURATION', 503);
  const ids = (() => {
    try {
      return z
        .array(identifier)
        .max(100)
        .refine((items) => new Set(items).size === items.length)
        .parse(JSON.parse(parsed.data.POS_MEMBERSHIP_PRODUCT_IDS) as unknown);
    } catch {
      throw importFinancialError('ORDER_IMPORT_PREPARATION_CONFIGURATION', 503);
    }
  })();
  return {
    contract: parsed.data.UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT,
    historyKey: parsed.data.CSV_MEMBERSHIP_HISTORY_KEY,
    publicationKey: parsed.data.CSV_MEMBERSHIP_PUBLICATION_KEY,
    couponHistoryKey: parsed.data.CSV_COUPON_HISTORY_KEY,
    couponPublicationKey: parsed.data.CSV_COUPON_PUBLICATION_KEY,
    couponGuardKey: parsed.data.CSV_COUPON_GUARD_KEY,
    membershipProofKey: parsed.data.POS_MEMBERSHIP_PROOF_KEY,
    memberProductIds: ids,
    warehouse: readCsvMembershipBigQueryOptions(env),
  };
}
export type SourceOrderPreparationOptions = ReturnType<typeof readSourceOrderPreparationOptions>;
