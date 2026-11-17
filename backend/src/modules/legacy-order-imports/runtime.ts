import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import type { StockProcedure } from '../administration/stock-procedure.js';
import { legacyOrderImportFinancialAdapter } from './financial-adapter.js';
import { legacyOrderImportFinancialApprovals } from './financial-adapter-approval.js';
import {
  legacyImportFinancialOptions,
  type LegacyImportFinancialOptions,
} from './financial-adapter-options.js';
import { legacyImportFinancialTransport } from './financial-adapter-transport.js';
import { readLegacyOrderImportOptions } from './options.js';
import type { LegacyOrderImportRegistrationOptions } from './service.js';
import { legacyOrderImportCorrections } from './correction-repository.js';
import { financialImportCorrectionBoundary } from './financial-adapter-correction-boundary.js';
import { configuredFinancialImportProfiles } from './membership-profile/options.js';
import { configuredSourceOrderPreparation } from './source-order-preparation-runtime.js';
import type { sourceOrderPreparation } from './source-order-preparation.js';
import { configuredCsvImportBenefits } from './benefit-profile/options.js';

/** Configuration inspection is pure: disabled/demo startup performs no I/O. */
export function configuredLegacyOrderImports(
  config: Config,
  db: Databases,
  options: {
    environment?: NodeJS.ProcessEnv;
    stockProcedure?: StockProcedure;
    observe?: LegacyImportFinancialOptions['observe'];
    clock?: () => number;
    fetcher?: typeof fetch;
    preparation?: Parameters<typeof sourceOrderPreparation>[3];
  } = {},
): LegacyOrderImportRegistrationOptions {
  const environment = config.DEMO_MODE ? {} : (options.environment ?? process.env),
    runtime = readLegacyOrderImportOptions(environment),
    key = runtime.LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1;
  if (!key) return { runtime };
  const financial = {
      ...legacyImportFinancialOptions(environment),
      stockProcedure: options.stockProcedure,
      observe: options.observe,
      clock: options.clock,
      fetcher: options.fetcher,
    },
    transport = legacyImportFinancialTransport(config, financial),
    preparation = configuredSourceOrderPreparation(
      config,
      financial,
      environment,
      options.preparation,
    ),
    benefits = configuredCsvImportBenefits(financial, environment),
    approvals = legacyOrderImportFinancialApprovals(config, db, financial),
    corrections = legacyOrderImportCorrections(db, config, {
      secret: key,
      contract: financial.correctionContract,
      boundary: financial.sourceProofKey
        ? financialImportCorrectionBoundary({
            secret: key,
            sourceProofKey: financial.sourceProofKey,
          })
        : undefined,
    }),
    recovery = {
      runtime,
      approvals,
      corrections,
      correctionForOperation: corrections.correctionForOperation,
    };
  let canStart = preparation.ready && benefits.ready;
  try {
    transport.assertReady();
  } catch (error: unknown) {
    if (error instanceof AppError && error.status === 503) canStart = false;
    else throw error;
  }
  return {
    ...recovery,
    canStart,
    // Immutable local receipts outlive the source transport, membership keys
    // and creation flags. Construction performs no database or network work.
    adapter: legacyOrderImportFinancialAdapter(
      config,
      db,
      financial,
      transport,
      configuredFinancialImportProfiles(financial, environment, {
        benefits: benefits.options,
        extensions: [
          ...(preparation.guard ? [preparation.guard] : []),
          ...(benefits.guard ? [benefits.guard] : []),
        ],
      }),
      preparation.port,
    ),
  };
}
