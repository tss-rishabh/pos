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

/** Configuration inspection is pure: disabled/demo startup performs no I/O. */
export function configuredLegacyOrderImports(
  config: Config,
  db: Databases,
  options: {
    environment?: NodeJS.ProcessEnv;
    stockProcedure?: StockProcedure;
    observe?: LegacyImportFinancialOptions['observe'];
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
    },
    transport = legacyImportFinancialTransport(config, financial),
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
  try {
    transport.assertReady();
  } catch (error: unknown) {
    if (error instanceof AppError && error.status === 503) return recovery;
    throw error;
  }
  return {
    ...recovery,
    adapter: legacyOrderImportFinancialAdapter(config, db, financial, transport),
  };
}
