import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import type { FinancialImportProfileHooks } from './financial-adapter-profiles.js';
import type { LegacyImportFinancialOptions } from './financial-adapter-options.js';
import type { FinancialOrderPreparationPort } from './financial-adapter-preparation-contracts.js';
import { importFinancialError } from './financial-adapter-crypto.js';
import { readSourceOrderPreparationOptions } from './source-order-preparation-options.js';
import { sourceOrderPreparation } from './source-order-preparation.js';
import { couponHistoryRuntime } from './benefit-profile/history-generation-runtime.js';
import {
  couponGenerationDemands,
  generationDemandContract,
} from './benefit-profile/history-generation-demands.js';

/** Pure installation. Invalid selected configuration blocks new work while
 * retaining the adapter/key needed to authenticate already committed results. */
export function configuredSourceOrderPreparation(
  config: Pick<Config, 'NODE_ENV' | 'BUSINESS_TIMEZONE'>,
  financial: LegacyImportFinancialOptions,
  environment: NodeJS.ProcessEnv,
  dependencies: Parameters<typeof sourceOrderPreparation>[3] = {},
  installation: { db?: Pick<Databases, 'get'> } = {},
): {
  readonly ready: boolean;
  readonly port?: FinancialOrderPreparationPort;
  readonly guard?: FinancialImportProfileHooks;
} {
  if (!environment.UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT) return { ready: true };
  try {
    const options = readSourceOrderPreparationOptions(environment),
      authority =
        financial.sourceProofKey && options.couponPublicationKey && options.couponHistoryKey
          ? {
              sourceKey: financial.sourceProofKey,
              publicationKey: options.couponPublicationKey,
              historyKey: options.couponHistoryKey,
            }
          : undefined,
      couponHistoryReader =
        dependencies.couponHistoryReader ?? couponHistoryRuntime(environment, authority);
    let couponHistoryDemand = dependencies.couponHistoryDemand;
    if (!couponHistoryDemand && environment.CSV_COUPON_GENERATION_DEMAND_CONTRACT) {
      const journalKey = environment.CSV_COUPON_GENERATION_JOURNAL_KEY,
        otherKeys = [
          financial.secret,
          financial.sourceAuthKey,
          financial.sourceProofKey,
          options.couponHistoryKey,
          options.couponPublicationKey,
          options.couponGuardKey,
          options.historyKey,
          options.publicationKey,
          options.membershipProofKey,
        ];
      if (
        environment.CSV_COUPON_GENERATION_DEMAND_CONTRACT !== generationDemandContract ||
        !journalKey ||
        !/^[!-~]{32,4096}$/.test(journalKey) ||
        otherKeys.includes(journalKey) ||
        !authority ||
        !couponHistoryReader ||
        !installation.db
      )
        throw importFinancialError('ORDER_IMPORT_PREPARATION_CONFIGURATION', 503);
      couponHistoryDemand = couponGenerationDemands(
        installation.db,
        { journalKey, sourceKey: authority.sourceKey },
        dependencies.clock ?? financial.clock,
      );
    }
    return {
      ready: true,
      port: sourceOrderPreparation(
        config,
        financial,
        options,
        { ...dependencies, couponHistoryReader, couponHistoryDemand },
      ),
    };
  } catch (error: unknown) {
    if (!(error instanceof AppError) || error.status !== 503) throw error;
    const deny = () => {
        throw importFinancialError('ORDER_IMPORT_PREPARATION_CONFIGURATION', 503);
      },
      denyAsync = async () => deny();
    return {
      ready: false,
      guard: {
        requiresCurrentReads: true,
        assertReady: deny,
        lock: denyAsync,
        dispatch: denyAsync,
        sourceReceipt: denyAsync,
        expectedQuantities: denyAsync,
        completionSnapshot: denyAsync,
      },
    };
  }
}
