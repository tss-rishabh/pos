import { z } from 'zod';
import type { CheckoutEnvironment } from '../checkout/gateway.js';
import { checkoutEnvironment } from '../checkout/gateway.js';
import type { StockProcedure } from '../administration/stock-procedure.js';
import type { FinancialImportStage } from './financial-adapter-contracts.js';
import {
  financialImportContract,
  financialSourceContract,
  financialPublicationContract,
  financialConfirmationContract,
} from './financial-adapter-contracts.js';
export interface LegacyImportFinancialOptions {
  secret: string;
  contract?: typeof financialImportContract;
  sourceContract?: typeof financialSourceContract;
  publicationContract?: typeof financialPublicationContract;
  confirmationContract?: typeof financialConfirmationContract;
  sourceUrl?: string;
  sourceAuthKey?: string;
  sourceProofKey?: string;
  checkout?: CheckoutEnvironment;
  stockContract?: 'pos-stock-projection-70b801-v1';
  stockProcedure?: StockProcedure;
  orderSchemaContract?: 'pos-offline-cash-order-schema-v1';
  clock?: () => number;
  fetcher?: typeof fetch;
  observe?: (event: {
    module: 'legacy-order-imports';
    resource: 'financial-imports';
    eventId:
      | 'legacy-order-imports.financial-imports.completed'
      | 'legacy-order-imports.financial-imports.uncertain'
      | 'legacy-order-imports.financial-imports.rejected';
    eventInstanceId: string;
    requestId: string;
    userId: string;
    stage: FinancialImportStage;
  }) => void;
}
export function legacyImportFinancialOptions(
  env: NodeJS.ProcessEnv = process.env,
): LegacyImportFinancialOptions {
  const optional = <T extends z.ZodType>(schema: T) =>
    z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
  const value = z
    .object({
      LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: z.string().regex(/^[!-~]{32,4096}$/),
      UPSTREAM_POS_LEGACY_IMPORT_FINANCIAL_CONTRACT: optional(z.literal(financialImportContract)),
      UPSTREAM_POS_LEGACY_IMPORT_SOURCE_CONTRACT: optional(z.literal(financialSourceContract)),
      UPSTREAM_POS_LEGACY_IMPORT_PUBLICATION_CONTRACT: optional(
        z.literal(financialPublicationContract),
      ),
      UPSTREAM_POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT: optional(
        z.literal(financialConfirmationContract),
      ),
      TSS_POS_LEGACY_IMPORT_URL: optional(z.url()),
      TSS_POS_LEGACY_IMPORT_KEY: optional(z.string().regex(/^[!-~]{32,4096}$/)),
      TSS_POS_LEGACY_IMPORT_PROOF_KEY: optional(z.string().regex(/^[!-~]{32,4096}$/)),
      POS_STOCK_PROJECTION_CONTRACT: optional(z.literal('pos-stock-projection-70b801-v1')),
      OFFLINE_CASH_ORDER_SCHEMA_CONTRACT: optional(z.literal('pos-offline-cash-order-schema-v1')),
    })
    .parse(env);
  return {
    secret: value.LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1,
    contract: value.UPSTREAM_POS_LEGACY_IMPORT_FINANCIAL_CONTRACT,
    sourceContract: value.UPSTREAM_POS_LEGACY_IMPORT_SOURCE_CONTRACT,
    publicationContract: value.UPSTREAM_POS_LEGACY_IMPORT_PUBLICATION_CONTRACT,
    confirmationContract: value.UPSTREAM_POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT,
    sourceUrl: value.TSS_POS_LEGACY_IMPORT_URL,
    sourceAuthKey: value.TSS_POS_LEGACY_IMPORT_KEY,
    sourceProofKey: value.TSS_POS_LEGACY_IMPORT_PROOF_KEY,
    checkout: checkoutEnvironment(env),
    stockContract: value.POS_STOCK_PROJECTION_CONTRACT,
    orderSchemaContract: value.OFFLINE_CASH_ORDER_SCHEMA_CONTRACT,
  };
}
