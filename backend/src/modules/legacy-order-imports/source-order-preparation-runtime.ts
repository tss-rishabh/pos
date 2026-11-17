import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import type { FinancialImportProfileHooks } from './financial-adapter-profiles.js';
import type { LegacyImportFinancialOptions } from './financial-adapter-options.js';
import type { FinancialOrderPreparationPort } from './financial-adapter-preparation-contracts.js';
import { importFinancialError } from './financial-adapter-crypto.js';
import { readSourceOrderPreparationOptions } from './source-order-preparation-options.js';
import { sourceOrderPreparation } from './source-order-preparation.js';

/** Pure installation. Invalid selected configuration blocks new work while
 * retaining the adapter/key needed to authenticate already committed results. */
export function configuredSourceOrderPreparation(
  config: Pick<Config, 'NODE_ENV' | 'BUSINESS_TIMEZONE'>,
  financial: LegacyImportFinancialOptions,
  environment: NodeJS.ProcessEnv,
  dependencies: Parameters<typeof sourceOrderPreparation>[3] = {},
): {
  readonly ready: boolean;
  readonly port?: FinancialOrderPreparationPort;
  readonly guard?: FinancialImportProfileHooks;
} {
  if (!environment.UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT) return { ready: true };
  try {
    return {
      ready: true,
      port: sourceOrderPreparation(
        config,
        financial,
        readSourceOrderPreparationOptions(environment),
        dependencies,
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
