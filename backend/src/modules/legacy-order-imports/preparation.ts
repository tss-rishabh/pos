import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { groupOfflineOrderCsv, groupShopifyOrderCsv } from './csv.js';
import { offlineOrderImportPlan, shopifyOrderImportPlan } from './plans.js';
import { importScopeSchema } from './sealed-groups.js';

const common = {
  id: z.uuid(),
  csv: z
    .string()
    .min(1)
    .max(5 * 1024 * 1024)
    .refine((value) => Buffer.byteLength(value) <= 5 * 1024 * 1024),
  counters: z.array(importScopeSchema).min(1).max(100),
};
export const legacyImportInputSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('offline') }).strict(),
  z.object({ ...common, kind: z.literal('shopify'), storeId: identifier }).strict(),
]);
export type LegacyImportInput = z.infer<typeof legacyImportInputSchema>;
export function prepareLegacyOrderImport(value: unknown) {
  const input = legacyImportInputSchema.parse(value),
    groups =
      input.kind === 'offline'
        ? groupOfflineOrderCsv(input.csv)
        : groupShopifyOrderCsv(input.csv, input.storeId),
    plans = groups.map((group) =>
      input.kind === 'offline' ? offlineOrderImportPlan(group) : shopifyOrderImportPlan(group),
    ),
    scopes = [...input.counters].sort((a, b) =>
      BigInt(a.storeId) < BigInt(b.storeId) ? -1 : BigInt(a.storeId) > BigInt(b.storeId) ? 1 : 0,
    ),
    stores = new Set(plans.map((plan) => plan.storeId)),
    counters = new Map(scopes.map((scope) => [scope.storeId, scope.counterId]));
  if (
    counters.size !== scopes.length ||
    scopes.length !== stores.size ||
    scopes.some((scope) => !stores.has(scope.storeId))
  )
    throw new AppError(
      422,
      'ORDER_IMPORT_COUNTER_SCOPE_INVALID',
      'Select exactly one counter for each imported store.',
    );
  if (
    input.kind === 'shopify' &&
    new Set(groups.map((group) => group.reference)).size !== groups.length
  )
    throw new AppError(
      422,
      'ORDER_IMPORT_DUPLICATE_REFERENCE',
      'Repeated Shopify order references require review.',
    );
  return { input, groups, plans, scopes, counters };
}
