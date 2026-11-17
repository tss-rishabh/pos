import type { CsvCouponHistoryPort } from './history.js';
import { qualifyCouponPublishedFacts, couponPublicationError } from './history-publication.js';
import {
  couponBigQueryOptionsSchema,
  requireCouponWarehouseOptions,
  couponWarehouseKeys,
  requireCouponWitness,
  type CouponBigQueryOptions,
} from './history-warehouse-contracts.js';
import {
  couponWarehouseReadRunner,
  type CouponWarehouseDependencies,
} from './history-warehouse-read.js';
import { couponHistoryScopeSchema } from './history.js';
/** Operation-scoped qualification adapter. Its publication binds the original
 * operation, so it cannot consume a prepublished generic generation for a new
 * sale. Never create native historical captures on request to make it fit.
 * Construction is pure; actual reads require a native witness and signal. */
export function couponBigQueryHistory(
  supplied: CouponBigQueryOptions,
  authority: { sourceKey: string; publicationKey: string; historyKey: string },
  dependencies: CouponWarehouseDependencies = {},
): CsvCouponHistoryPort {
  const parsed = couponBigQueryOptionsSchema.safeParse(supplied);
  if (!parsed.success) throw couponPublicationError('CONFIGURATION', 503);
  couponWarehouseKeys(authority.sourceKey, authority.publicationKey, authority.historyKey);
  const options = Object.freeze(parsed.data),
    keys = Object.freeze({ ...authority }),
    runner = couponWarehouseReadRunner(options, dependencies);
  return {
    async read(input, readOptions) {
      requireCouponWarehouseOptions(options, 'read');
      const parsedScope = couponHistoryScopeSchema.safeParse(input);
      if (!parsedScope.success) throw couponPublicationError('QUERY_SCOPE');
      const scope = parsedScope.data;
      if (!readOptions?.witness || !(readOptions.signal instanceof AbortSignal))
        throw couponPublicationError('WITNESS_REQUIRED', 503);
      const witness = requireCouponWitness(scope, readOptions.witness, keys.sourceKey),
        result = await runner.read(scope, witness, keys.sourceKey, readOptions.signal, 'read');
      if (!result.publication) throw couponPublicationError('WAREHOUSE_INCOMPLETE');
      return qualifyCouponPublishedFacts(
        result.publication,
        scope,
        result.facts,
        keys,
        runner.clock(),
      );
    },
  };
}
