import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { AppError } from '../../../domain/errors.js';
import { importFinancialError } from '../financial-adapter-crypto.js';
import {
  financialAdapterProfiles,
  type FinancialAdapterProfileOptions,
} from '../financial-adapter-profiles.js';
import type { LegacyImportFinancialOptions } from '../financial-adapter-options.js';
import type { CsvMembershipOptions } from './native.js';
import { csvMembershipContract } from './domain.js';
import { csvMembershipReferenceContract } from './reference-contracts.js';
import { csvMembershipStagedReferenceContract } from './staged-reference-contracts.js';

const key = z.string().regex(/^[!-~]{32,4096}$/);
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
const productIds = z
  .string()
  .max(32000)
  .transform((value, context): string[] => {
    try {
      const parsed = z
        .array(identifier)
        .max(1000)
        .refine((ids) => new Set(ids).size === ids.length)
        .safeParse(JSON.parse(value) as unknown);
      if (parsed.success) return parsed.data;
    } catch {
      /* Only a static configuration error leaves this boundary. */
    }
    context.addIssue({
      code: 'custom',
      message: 'A trusted membership product registry is required.',
    });
    return z.NEVER;
  });

/** Pure server configuration. Source proof authority comes from the already
 * validated financial options, never a second alias or an import request. */
export function readCsvImportMembershipOptions(
  financial: Pick<LegacyImportFinancialOptions, 'sourceProofKey'>,
  environment: NodeJS.ProcessEnv = process.env,
): CsvMembershipOptions {
  const parsed = z
    .object({
      POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT: optional(z.literal(csvMembershipContract)),
      POS_MEMBERSHIP_FRESH_READER_CONTRACT: optional(z.literal('pos-membership-fresh-reader-v1')),
      POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT: optional(
        z.literal('pos-membership-native-revision-v1'),
      ),
      POS_MEMBERSHIP_PROOF_KEY: optional(key),
      POS_LEGACY_IMPORT_MEMBERSHIP_REFERENCE_CONTRACT: optional(
        z.literal(csvMembershipReferenceContract),
      ),
      POS_LEGACY_IMPORT_MEMBERSHIP_STAGED_REFERENCE_CONTRACT: optional(
        z.literal(csvMembershipStagedReferenceContract),
      ),
      CUSTOMER_CONTACTS_SECRET: optional(key),
      BUSINESS_TIMEZONE: z.string().min(1).max(80).default('Asia/Kolkata'),
      POS_MEMBERSHIP_PRODUCT_IDS: productIds.prefault('[]'),
      EXCLUSIVE_QUARTERLY_ID_FREE: z.preprocess(
        (value) => (value === '0' || value === '' ? undefined : value),
        identifier.optional(),
      ),
    })
    .safeParse(environment);
  if (!parsed.success)
    throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_CONFIGURATION_REQUIRED', 503);
  const value = parsed.data;
  if (
    value.POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT &&
    (!value.POS_MEMBERSHIP_FRESH_READER_CONTRACT ||
      !value.POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT ||
      !value.POS_MEMBERSHIP_PROOF_KEY ||
      !key.safeParse(financial.sourceProofKey).success ||
      !value.POS_MEMBERSHIP_PRODUCT_IDS.length ||
      !value.EXCLUSIVE_QUARTERLY_ID_FREE ||
      !value.POS_MEMBERSHIP_PRODUCT_IDS.includes(value.EXCLUSIVE_QUARTERLY_ID_FREE))
  )
    throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_CONFIGURATION_REQUIRED', 503);
  if (
    (value.POS_LEGACY_IMPORT_MEMBERSHIP_REFERENCE_CONTRACT ||
      value.POS_LEGACY_IMPORT_MEMBERSHIP_STAGED_REFERENCE_CONTRACT) &&
    (!value.CUSTOMER_CONTACTS_SECRET ||
      !value.POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT ||
      value.CUSTOMER_CONTACTS_SECRET === value.POS_MEMBERSHIP_PROOF_KEY ||
      value.CUSTOMER_CONTACTS_SECRET === financial.sourceProofKey)
  )
    throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_CONFIGURATION_REQUIRED', 503);
  return {
    contract: value.POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT ?? '',
    freshReaderContract: value.POS_MEMBERSHIP_FRESH_READER_CONTRACT ?? '',
    sourceProofKey: financial.sourceProofKey ?? '',
    membershipProofKey: value.POS_MEMBERSHIP_PROOF_KEY ?? '',
    productIds: value.POS_MEMBERSHIP_PRODUCT_IDS,
    freeProductId: value.EXCLUSIVE_QUARTERLY_ID_FREE ?? '',
    referenceContract: value.POS_LEGACY_IMPORT_MEMBERSHIP_REFERENCE_CONTRACT,
    stagedReferenceContract: value.POS_LEGACY_IMPORT_MEMBERSHIP_STAGED_REFERENCE_CONTRACT,
    contactSecret: value.CUSTOMER_CONTACTS_SECRET,
    businessTimezone: value.BUSINESS_TIMEZONE,
  };
}
export function configuredFinancialImportProfiles(
  financial: Pick<LegacyImportFinancialOptions, 'sourceProofKey'>,
  environment: NodeJS.ProcessEnv = process.env,
  other: Omit<FinancialAdapterProfileOptions, 'membership'> = {},
) {
  try {
    return financialAdapterProfiles({
      ...other,
      membership: readCsvImportMembershipOptions(financial, environment),
    });
  } catch (error: unknown) {
    if (
      !(error instanceof AppError) ||
      error.code !== 'ORDER_IMPORT_MEMBERSHIP_CONFIGURATION_REQUIRED'
    )
      throw error;
    // Bad current admission configuration cannot erase an authenticated old
    // financial receipt. It also cannot become an ordinary-import bypass.
    const deny = () => {
        throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_CONFIGURATION_REQUIRED', 503);
      },
      denyAsync = async () => deny();
    return financialAdapterProfiles({
      ...other,
      extensions: [
        {
          requiresCurrentReads: true,
          assertReady: deny,
          lock: denyAsync,
          dispatch: denyAsync,
          sourceReceipt: denyAsync,
          expectedQuantities: denyAsync,
          completionSnapshot: denyAsync,
        },
        ...(other.extensions ?? []),
      ],
    });
  }
}
