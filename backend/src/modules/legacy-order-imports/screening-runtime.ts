import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { LegacyImportFinancialOptions } from './financial-adapter-options.js';
import type {
  FinancialAdapterProfileOptions,
  FinancialImportProfileHooks,
} from './financial-adapter-profiles.js';
import { importFinancialError } from './financial-adapter-crypto.js';
import {
  screeningImportProfile,
  screeningProfileContract,
  screeningSchemaContract,
  screeningWriterContract,
} from './screening-profile.js';
import { readScreeningCounterOptions } from './screening-counter/reader.js';
import { counterContract } from './screening-counter/contracts.js';

/** Explicit server installation only. An absent profile never reads optional
 * counter configuration, opens SQL, or admits ticket imports by default. */
export function configuredCsvImportScreening(
  config: Config,
  db: Databases,
  financial: Pick<
    LegacyImportFinancialOptions,
    'secret' | 'sourceProofKey' | 'sourceAuthKey' | 'clock'
  >,
  environment: NodeJS.ProcessEnv,
): {
  ready: boolean;
  screening?: FinancialAdapterProfileOptions['screening'];
  guard?: FinancialImportProfileHooks;
} {
  if (!environment.POS_LEGACY_IMPORT_SCREENING_CONTRACT) return { ready: true };
  try {
    const value = z
      .object({
        POS_LEGACY_IMPORT_SCREENING_CONTRACT: z.literal(screeningProfileContract),
        POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT: z.literal(screeningSchemaContract),
        POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT: z.literal(screeningWriterContract),
        POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED: z.enum(['0', '1']),
      })
      .parse(environment);
    const key = z.string().regex(/^[!-~]{32,4096}$/);
    key.parse(financial.sourceProofKey);
    key.parse(financial.secret);
    const counter = readScreeningCounterOptions(environment);
    if (
      counter.contract !== counterContract ||
      !key.safeParse(counter.publicationKey).success ||
      !counter.headMetadata?.counterDefiner ||
      [financial.secret, financial.sourceProofKey, financial.sourceAuthKey].includes(
        counter.publicationKey,
      ) ||
      financial.secret === financial.sourceProofKey
    )
      throw importFinancialError('ORDER_IMPORT_SCREENING_UNQUALIFIED', 503);
    const profile = screeningImportProfile(config, db, {
      contract: value.POS_LEGACY_IMPORT_SCREENING_CONTRACT,
      schemaContract: value.POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT,
      writerContract: value.POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT,
      financialSecret: financial.secret,
      proofKey: financial.sourceProofKey!,
      clock: financial.clock,
      counter,
    });
    profile.assertReady();
    return {
      ready: true,
      screening: {
        profile,
        lineItemsEnabled: value.POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED === '1',
      },
    };
  } catch {
    // Invalid new-work configuration does not remove the adapter/key used to
    // authenticate an immutable completed receipt. No selected fallback exists.
    const deny = () => {
      throw importFinancialError('ORDER_IMPORT_SCREENING_UNQUALIFIED', 503);
    };
    const denyAsync = async () => deny();
    return {
      ready: false,
      guard: {
        requiresCurrentReads: true,
        assertReady: deny,
        reserved: denyAsync,
        lock: denyAsync,
        dispatch: denyAsync,
        sourceReceipt: denyAsync,
        expectedQuantities: denyAsync,
        completionSnapshot: denyAsync,
        qualifiedBenefits: denyAsync,
        benefitSnapshot: denyAsync,
        preparationResumed: denyAsync,
      },
    };
  }
}
